// 自动领取调度器：北京时间 19:00–23:59 窗口内每 30 分钟对"尚未成功"的账号重试，
// 只重试可重试的失败；已成功 / 不可重试失败的账号当天不再打上游。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createClaimScheduler, inClaimWindow, isRetryableFailure } from '../pools/claim-scheduler.mjs';
import { writeSettings, DEFAULT_SETTINGS } from '../pools/settings.mjs';

const MIN = 60_000;
const HOUR = 3_600_000;

/** 北京时间某个整点对应的 UTC 毫秒。 */
function bjMs(day, hour, minute = 0) {
  return Date.UTC(day[0], day[1], day[2], hour - 8, minute, 0);
}

const MON_19 = bjMs([2026, 10, 23], 19); // 2026-11-23 周一 19:00 北京时间
const WEEK = [2026, 10, 23];

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ugw-claim-sched-'));
}

function makeHarness({ settings = {}, results = [], accounts = [{ id: 'a1' }, { id: 'a2' }] } = {}) {
  const dir = tmpDir();
  const settingsFile = path.join(dir, 'pool-settings.json');
  writeSettings(settingsFile, { ...DEFAULT_SETTINGS, ...settings });
  let clock = MON_19;
  const calls = [];
  const claimer = {
    async run(acc) {
      calls.push({ at: clock, id: acc.id });
      const r = typeof results === 'function' ? results(acc) : results;
      return r;
    },
  };
  const pool = { name: 'zcode', accounts };
  const scheduler = createClaimScheduler({
    pools: [pool],
    claimers: { zcode: claimer },
    settingsFile,
    dataDir: dir,
    now: () => clock,
    tickMs: 1,
  });
  return {
    scheduler,
    dir,
    calls,
    setClock: (v) => (clock = v),
    advance: (ms) => (clock += ms),
  };
}

// ---------- 纯函数 ----------

test('inClaimWindow：19:00 起、23:59 止，18:59 与次日 00:00 不在窗口内', () => {
  const s = { autoClaimStartHour: 19, autoClaimEndHour: 24 };
  assert.equal(inClaimWindow(bjOf(MON_19 - 1), s), false, '18:59:59 不在窗口');
  assert.equal(inClaimWindow(bjOf(MON_19), s), true, '19:00 在窗口');
  assert.equal(inClaimWindow(bjOf(MON_19 + 4 * HOUR + 59 * MIN), s), true, '23:59 在窗口');
  assert.equal(inClaimWindow(bjOf(MON_19 + 5 * HOUR), s), false, '次日 00:00 不在窗口');
});

test('inClaimWindow 用固定 UTC+8，不受宿主机时区影响', () => {
  const s = { autoClaimStartHour: 19, autoClaimEndHour: 24 };
  // 同一绝对时刻，两种构造方式必须得到相同判定
  const t = bjMs(WEEK, 19, 30);
  assert.equal(inClaimWindow(bjOf(t), s), true);
  assert.equal(inClaimWindow(bjOf(t + 1), s), true);
});

function bjOf(ms) {
  const d = new Date(ms + 8 * HOUR);
  return { date: d.toISOString().slice(0, 10), hour: d.getUTCHours(), weekday: d.getUTCDay() };
}

test('isRetryableFailure：只有 failed 且未标记不可重试才算可重试', () => {
  assert.equal(isRetryableFailure({ status: 'failed', detail: {} }), true, '普通失败可重试');
  assert.equal(isRetryableFailure({ status: 'failed' }), true);
  assert.equal(isRetryableFailure({ status: 'failed', detail: { retryable: false } }), false, '凭证/验证码类不重试');
  assert.equal(isRetryableFailure({ status: 'claimed' }), false);
  assert.equal(isRetryableFailure({ status: 'already' }), false);
  assert.equal(isRetryableFailure({ status: 'none' }), false);
  assert.equal(isRetryableFailure(null), false);
});

// ---------- 调度行为 ----------

test('窗口外 tick 不跑任何领取', async () => {
  const h = makeHarness({ results: () => ({ ok: true, status: 'claimed' }) });
  h.setClock(MON_19 - 2 * HOUR); // 17:00
  h.scheduler.tick();
  await settle();
  assert.equal(h.calls.length, 0);
});

test('一进窗口就对所有账号跑一轮', async () => {
  const h = makeHarness({ results: () => ({ ok: true, status: 'claimed' }) });
  h.scheduler.tick();
  await settle();
  assert.deepEqual(h.calls.map((c) => c.id), ['a1', 'a2']);
});

test('已成功的账号当天不再重试；可重试失败 30 分钟后重试', async () => {
  const h = makeHarness({
    results: (acc) =>
      acc.id === 'a1'
        ? { ok: true, status: 'claimed' }
        : { ok: false, status: 'failed', message: '1005', detail: {} },
  });
  h.scheduler.tick();
  await settle();
  assert.deepEqual(h.calls.map((c) => c.id), ['a1', 'a2']);

  // 10 分钟后：a1 已成功跳过，a2 未到 30 分钟间隔也跳过
  h.advance(10 * MIN);
  h.scheduler.tick();
  await settle();
  assert.equal(h.calls.length, 2, '间隔未到不得重复打上游');

  // 30 分钟后：只重试 a2
  h.advance(21 * MIN);
  h.scheduler.tick();
  await settle();
  assert.deepEqual(h.calls.slice(2).map((c) => c.id), ['a2']);
});

test('不可重试失败（凭证失效/验证码）当天放弃，不再重试', async () => {
  const h = makeHarness({ results: () => ({ ok: false, status: 'failed', detail: { retryable: false } }) });
  h.scheduler.tick();
  await settle();
  assert.equal(h.calls.length, 2, '首轮两个账号各一次');

  h.advance(40 * MIN);
  h.scheduler.tick();
  await settle();
  assert.equal(h.calls.length, 2, '不可重试失败不得再打上游');
});

test('重试直到窗口结束：23:59 前仍在重试，次日窗口重新开始', async () => {
  const h = makeHarness({ results: () => ({ ok: false, status: 'failed', detail: {} }) });
  h.scheduler.tick();
  await settle();
  h.setClock(bjMs(WEEK, 23, 59));
  h.scheduler.tick();
  await settle();
  assert.ok(h.calls.length >= 4, '窗口末尾仍应重试');

  // 次日 00:05 不在窗口
  const before = h.calls.length;
  h.setClock(bjMs([2026, 10, 24], 0, 5));
  h.scheduler.tick();
  await settle();
  assert.equal(h.calls.length, before, '跨到次日 00:05 不再跑');

  // 次日 19:00 新窗口，重新开始
  h.setClock(bjMs([2026, 10, 24], 19));
  h.scheduler.tick();
  await settle();
  assert.equal(h.calls.length, before + 2, '新的一天窗口重新开始');
});

test('enabled=false / needs_login 的账号不被触碰', async () => {
  const h = makeHarness({
    accounts: [{ id: 'ok' }, { id: 'off', enabled: false }, { id: 'bad', state: 'needs_login' }],
    results: () => ({ ok: true, status: 'claimed' }),
  });
  h.scheduler.tick();
  await settle();
  assert.deepEqual(h.calls.map((c) => c.id), ['ok']);
});

test('claimer 抛错不会中断其它账号，也不会卡住 running 标志', async () => {
  const h = makeHarness({
    results: () => {
      throw new Error('boom');
    },
  });
  h.scheduler.tick();
  await settle();
  assert.equal(h.calls.length, 2, '两个账号都应被尝试');
  // 再来一次仍能跑（running 已复位）
  h.advance(31 * MIN);
  h.scheduler.tick();
  await settle();
  assert.equal(h.calls.length, 4);
});

test('状态落盘：claims-state.json 记录当天每个账号的结论', async () => {
  const h = makeHarness({ results: () => ({ ok: true, status: 'already' }) });
  h.scheduler.tick();
  await settle();
  const state = JSON.parse(fs.readFileSync(path.join(h.dir, 'claims-state.json'), 'utf8'));
  const day = state.days?.['2026-11-23'];
  assert.ok(day, '按北京日期分桶');
  assert.equal(day.zcode.a1.lastStatus, 'already');
  assert.equal(typeof day.zcode.a1.lastAt, 'number');
});

test('未启用自动领取时窗口内也不跑', async () => {
  const h = makeHarness({ settings: { autoClaimEnabled: 0 }, results: () => ({ ok: true, status: 'claimed' }) });
  h.scheduler.tick();
  await settle();
  assert.equal(h.calls.length, 0);
});

async function settle() {
  // tick 是 fire-and-forget 的异步任务；让出事件循环直到它跑完
  for (let i = 0; i < 50; i++) await new Promise((r) => setImmediate(r));
}
