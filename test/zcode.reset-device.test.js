// 领取成功后重置设备指纹：上游按设备发放「首次资格」，同一 device-mid 领过就不再下发。
// 三条硬约束：只在 claimed 触发；none / already 不触发；落盘后重读必须是新值（防两份数组互相覆盖）。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createZcodePool } from '../pools/zcode/index.mjs';
import { loadAccounts, saveAccounts } from '../pools/zcode/accounts.mjs';
import { createClaimScheduler } from '../pools/claim-scheduler.mjs';
import { writeSettings, DEFAULT_SETTINGS } from '../pools/settings.mjs';
import { randomDeviceId } from '../core/fingerprint.mjs';

const ORIGIN = 'https://stub.invalid';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ugw-zcode-reset-'));
}

/** 真池 + 假 claimer：只关心重置行为，不碰上游 HTTP。 */
function makeHarness({ result, settings = {}, accounts = [{ id: 'z1', uid: 'uid-1', jwt: 'j', deviceId: 'device-old' }] } = {}) {
  const dir = tmpDir();
  const settingsFile = path.join(dir, 'pool-settings.json');
  writeSettings(settingsFile, { ...DEFAULT_SETTINGS, ...settings });
  saveAccounts(dir, accounts.map((a) => ({ ...a })));

  const pool = createZcodePool({
    accounts: loadAccounts(dir),
    accountsDir: dir,
    profile: null,
    config: { origin: ORIGIN, settingsFile },
    fetchImpl: () => {
      throw new Error('不该打上游');
    },
  });

  const claimer = { name: 'zcode', run: async () => result };
  const scheduler = createClaimScheduler({
    pools: [pool],
    claimers: { zcode: claimer },
    settingsFile,
    dataDir: dir,
    now: () => Date.UTC(2026, 10, 23, 11, 0, 0), // 北京 19:00
  });
  return { dir, pool, scheduler };
}

const claimed = { ok: true, status: 'claimed', claimed: ['p1'], credits: 100, message: 'ok' };
const nothing = { ok: true, status: 'none', claimed: [], credits: 0, message: '当前无新套餐' };
const already = { ok: true, status: 'already', claimed: [], credits: 0, message: '已领取过' };

test('randomDeviceId 保持 UUIDv4 形态且每次不同', () => {
  const a = randomDeviceId();
  const b = randomDeviceId();
  assert.notEqual(a, b, '两次生成不能相同');
  assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/, '第 13 位 4、第 17 位 a');
});

test('领取成功后换设备，且落盘重读是新值', async () => {
  const { dir, pool, scheduler } = makeHarness({ result: claimed });
  await scheduler.runAll();

  const live = pool.accounts.find((a) => a.id === 'z1');
  assert.notEqual(live.deviceId, 'device-old', '运行态必须换掉');

  const onDisk = loadAccounts(dir).find((a) => a.id === 'z1');
  assert.equal(onDisk.deviceId, live.deviceId, '磁盘必须和运行态一致（两份数组不能互相覆盖）');
});

test('none 不触发重置（避免一天密集换 32 次身份）', async () => {
  const { dir, pool, scheduler } = makeHarness({ result: nothing });
  await scheduler.runAll();
  assert.equal(loadAccounts(dir).find((a) => a.id === 'z1').deviceId, 'device-old');
  assert.equal(pool.accounts.find((a) => a.id === 'z1').deviceId, 'device-old');
});

test('already 不触发重置', async () => {
  const { dir, scheduler } = makeHarness({ result: already });
  await scheduler.runAll();
  assert.equal(loadAccounts(dir).find((a) => a.id === 'z1').deviceId, 'device-old');
});

test('resetDeviceOnClaim 关闭后领取成功也不重置', async () => {
  const { dir, scheduler } = makeHarness({ result: claimed, settings: { resetDeviceOnClaim: 0 } });
  await scheduler.runAll();
  assert.equal(loadAccounts(dir).find((a) => a.id === 'z1').deviceId, 'device-old');
});

test('未配 accountsDir 时只改运行态，不抛错', async () => {
  const dir = tmpDir();
  const pool = createZcodePool({
    accounts: [{ id: 'z1', uid: 'u', jwt: 'j', deviceId: 'device-old' }],
    profile: null,
    config: { origin: ORIGIN },
  });
  const next = pool.resetDeviceId(pool.accounts[0]);
  assert.notEqual(next, 'device-old');
  assert.equal(pool.accounts[0].deviceId, next);
});
