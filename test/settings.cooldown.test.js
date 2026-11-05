import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_SETTINGS, loadSettings, patchSettings } from '../pools/settings.mjs';
import { createPoolScheduler } from '../pools/base.mjs';

function tmpFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ugw-settings-cooldown-'));
  return { dir, file: path.join(dir, 'pool-settings.json') };
}

test('new cooldown/auto-claim keys default correctly with no file or env', () => {
  const { file } = tmpFile();
  const settings = loadSettings({ file, env: {} });
  assert.equal(settings.breakerCooldownMs, 1_800_000);
  assert.equal(settings.breakerCapMs, 21_600_000);
  assert.equal(settings.quotaExhaustedCooldownMs, 43_200_000);
  assert.equal(settings.autoClaimEnabled, 1);
  assert.equal(settings.autoClaimHour, 9);
  assert.equal(settings.weekendGrabEnabled, 1);
});

test('environment variables override the new keys', () => {
  const { file } = tmpFile();
  const settings = loadSettings({
    file,
    env: {
      UGW_BREAKER_COOLDOWN_MS: '60000',
      UGW_BREAKER_CAP_MS: '3600000',
      UGW_QUOTA_EXHAUSTED_COOLDOWN_MS: '7200000',
      UGW_AUTO_CLAIM: '0',
      UGW_AUTO_CLAIM_HOUR: '8',
      UGW_WEEKEND_GRAB: '0',
    },
  });
  assert.equal(settings.breakerCooldownMs, 60_000);
  assert.equal(settings.breakerCapMs, 3_600_000);
  assert.equal(settings.quotaExhaustedCooldownMs, 7_200_000);
  assert.equal(settings.autoClaimEnabled, 0);
  assert.equal(settings.autoClaimHour, 8);
  assert.equal(settings.weekendGrabEnabled, 0);
});

test('file values override and clamp: duration 0 -> 1, hour 99 -> 23, flag 5 -> 1', () => {
  const { file } = tmpFile();
  fs.writeFileSync(
    file,
    JSON.stringify({
      breakerCooldownMs: 0,
      breakerCapMs: -5,
      quotaExhaustedCooldownMs: 0,
      autoClaimEnabled: 5,
      autoClaimHour: 99,
      weekendGrabEnabled: 'yes',
    }),
  );
  const settings = loadSettings({ file, env: {} });
  assert.equal(settings.breakerCooldownMs, 1);
  assert.equal(settings.breakerCapMs, 1);
  assert.equal(settings.quotaExhaustedCooldownMs, 1);
  assert.equal(settings.autoClaimEnabled, 1);
  assert.equal(settings.autoClaimHour, 23);
  assert.equal(settings.weekendGrabEnabled, 1, '非空字符串 >0 视为开');
});

test('patchSettings clamps and persists all new keys atomically', () => {
  const { file } = tmpFile();
  const base = loadSettings({ file, env: {} });
  const next = patchSettings({
    file,
    settings: base,
    patch: {
      breakerCooldownMs: 1000,
      breakerCapMs: 2000,
      quotaExhaustedCooldownMs: 3000,
      autoClaimEnabled: false,
      autoClaimHour: -1,
      weekendGrabEnabled: 0,
    },
  });
  assert.equal(next.breakerCooldownMs, 1000);
  assert.equal(next.breakerCapMs, 2000);
  assert.equal(next.quotaExhaustedCooldownMs, 3000);
  assert.equal(next.autoClaimEnabled, 0);
  assert.equal(next.autoClaimHour, 0);
  assert.equal(next.weekendGrabEnabled, 0);

  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(onDisk, next);
  assert.deepEqual(loadSettings({ file, env: {} }), next, '落盘后重新加载保持同值');
});

test('base scheduler reads breaker durations from settings and honors patchSettings immediately', () => {
  const { file } = tmpFile();
  const base = loadSettings({ file, env: {} });
  const t0 = 1_000_000_000;
  let clock = t0;
  const scheduler = createPoolScheduler({
    name: 't',
    accounts: [{ id: 'a1' }, { id: 'a2' }, { id: 'a3' }],
    settings: base,
    settingsFile: file,
    now: () => clock,
  });
  const acc = scheduler.accounts[0];

  // 第 3 次连续失败触发熔断：base = breakerCooldownMs * 2^0
  const breakerCooldownMs = 60_000;
  const breakerCapMs = 90_000;
  scheduler.patchSettings({ breakerCooldownMs, breakerCapMs, quotaExhaustedCooldownMs: 120_000 });
  scheduler.onUpstreamError(acc, { kind: 'server' });
  scheduler.onUpstreamError(acc, { kind: 'server' });
  let until = scheduler.onUpstreamError(acc, { kind: 'server' });
  assert.equal(acc.consecutiveFails, 3);
  assert.equal(until, clock + breakerCooldownMs, '熔断基数取自 breakerCooldownMs');

  // 第 4 次：翻倍到 120000，但被封顶在 breakerCapMs
  clock += 1;
  until = scheduler.onUpstreamError(acc, { kind: 'server' });
  assert.equal(until, clock + breakerCapMs, '指数增长被封顶在 breakerCapMs');

  // 额度耗尽用配置值，且 patch 后立即生效
  clock = t0 + 1_000_000;
  const acc2 = scheduler.accounts[1];
  scheduler.updateAccount('a1', { state: 'ok', consecutiveFails: 0, cooldownUntil: 0 });
  scheduler.onUpstreamError(acc2, { kind: 'quota_exhausted' });
  assert.equal(acc2.cooldownUntil, clock + 120_000, 'quota_exhausted 冷却取自 quotaExhaustedCooldownMs');
  scheduler.patchSettings({ quotaExhaustedCooldownMs: 30_000 });
  const acc3 = scheduler.accounts[2];
  scheduler.onUpstreamError(acc3, { kind: 'quota' });
  assert.equal(acc3.cooldownUntil, clock + 30_000, 'patchSettings 立即影响下一次惩罚');

  // patch 已同步落盘
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(onDisk.breakerCooldownMs, breakerCooldownMs);
  assert.equal(onDisk.breakerCapMs, breakerCapMs);
  assert.equal(onDisk.quotaExhaustedCooldownMs, 30_000);
});
