import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_SETTINGS, loadSettings, patchSettings } from '../pools/settings.mjs';
import { COOLDOWN } from '../pools/zcode/index.mjs';

function tmpFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ugw-pool-settings-'));
  return { dir, file: path.join(dir, 'pool-settings.json') };
}

test('no settings file falls back to the defaults', () => {
  const { file } = tmpFile();
  assert.deepEqual(loadSettings({ file, env: {} }), { ...DEFAULT_SETTINGS });
  assert.equal(DEFAULT_SETTINGS.maxInFlight, 5);
  assert.equal(DEFAULT_SETTINGS.topN, 3);
  assert.equal(DEFAULT_SETTINGS.stickyTtlMs, 1_800_000);
  assert.equal(DEFAULT_SETTINGS.maxAttempts, 3);
  assert.equal(DEFAULT_SETTINGS.breakerThreshold, 3);
  assert.equal(DEFAULT_SETTINGS.blockedCooldownMs, 600_000);
  assert.equal(DEFAULT_SETTINGS.busyCooldownMs, 90_000);
  assert.equal(DEFAULT_SETTINGS.quotaCooldownMs, 1_800_000);
  assert.equal(DEFAULT_SETTINGS.serverCooldownMs, 60_000);
});

test('environment variables seed the defaults when no file exists', () => {
  const { file } = tmpFile();
  const settings = loadSettings({ file, env: { UGW_TOPN: '2', UGW_MAX_ATTEMPTS: '4', UGW_STICKY_TTL_MS: '60000' } });
  assert.equal(settings.topN, 2);
  assert.equal(settings.maxAttempts, 4);
  assert.equal(settings.stickyTtlMs, 60_000);
});

test('the settings file wins over environment variables', () => {
  const { file } = tmpFile();
  fs.writeFileSync(file, JSON.stringify({ maxInFlight: 9, topN: 2 }));
  const settings = loadSettings({ file, env: { UGW_MAX_INFLIGHT: '7', UGW_TOPN: '1', UGW_BUSY_COOLDOWN_MS: '12345' } });
  assert.equal(settings.maxInFlight, 9);
  assert.equal(settings.topN, 2);
  assert.equal(settings.busyCooldownMs, 12_345, '文件缺的字段仍由环境变量补齐');
  assert.equal(settings.maxAttempts, DEFAULT_SETTINGS.maxAttempts);
});

test('patchSettings clamps values and persists them atomically', () => {
  const { file } = tmpFile();
  const base = loadSettings({ file, env: {} });
  const next = patchSettings({
    file,
    settings: base,
    patch: { topN: 0, maxAttempts: 0, maxInFlight: '8', breakerThreshold: -1, stickyTtlMs: -5, unknown: 1 },
  });

  assert.equal(next.topN, 1);
  assert.equal(next.maxAttempts, 1);
  assert.equal(next.maxInFlight, 8);
  assert.equal(next.breakerThreshold, 1);
  assert.equal(next.stickyTtlMs, 0);
  assert.equal('unknown' in next, false);

  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(onDisk, next);
  assert.deepEqual(loadSettings({ file, env: {} }), next, '落盘后重新加载保持同值');
});

test('the zcode COOLDOWN table derives from DEFAULT_SETTINGS (no drift)', () => {
  assert.equal(COOLDOWN.blocked, DEFAULT_SETTINGS.blockedCooldownMs);
  assert.equal(COOLDOWN.busy, DEFAULT_SETTINGS.busyCooldownMs);
  assert.equal(COOLDOWN.quota, DEFAULT_SETTINGS.quotaCooldownMs);
  assert.equal(COOLDOWN.server, DEFAULT_SETTINGS.serverCooldownMs);
});

test('a corrupt settings file falls back to defaults without throwing', () => {
  const { file } = tmpFile();
  fs.writeFileSync(file, '{ not json');
  assert.deepEqual(loadSettings({ file, env: {} }), { ...DEFAULT_SETTINGS });
});

test('a settings file with bad types is ignored field by field', () => {
  const { file } = tmpFile();
  fs.writeFileSync(file, JSON.stringify({ topN: 'abc', maxInFlight: 4 }));
  const settings = loadSettings({ file, env: {} });
  assert.equal(settings.topN, DEFAULT_SETTINGS.topN);
  assert.equal(settings.maxInFlight, 4);
});
