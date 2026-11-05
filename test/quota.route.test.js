// 面板 quota 路由 + 领取联动测试（M8 追加）：
// - 签到列以 claimer.status 为准（quota 自带的签到查询是矛盾链路：trae 已废弃契约、
//   workbuddy 打错域），成功且 supported 覆盖、抛错回落、unsupported 保留 message；
// - 领取成功 → pool.quota.invalidate(acc) 清缓存（面板路由 + claim-scheduler 两处）；
// - zcode quota 模块 invalidate 单测：get 命中缓存 → invalidate 后重新回源。
// 桩面板走 test/helpers/panel.mjs 真 HTTP；桩上游走 test/helpers/stub.mjs。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpDataDir, startPanel, makePool, login, panelFetch } from './helpers/panel.mjs';
import { startStub } from './helpers/stub.mjs';
import { createClaimScheduler } from '../pools/claim-scheduler.mjs';
import { createQuotaCache as createZcodeQuotaCache } from '../pools/zcode/quota.mjs';
import { displayNameOf } from '../panel/api.mjs';

const json = (res, obj, status = 200) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
};

/** 桩池 + 桩 claimer：quota.get 返回可配置的 checkin；记录 invalidate 调用。 */
function makeQuotaPool(dataDir, { quotaCheckin = null, claimerStatus, claimerRun } = {}) {
  const invalidates = [];
  const pool = makePool('zcode', {
    dataDir,
    accounts: [
      { id: 'acc-1', label: '测试号', enabled: true },
      { id: 'acc-2', label: '禁用号', enabled: false },
    ],
  });
  pool.quota = {
    get: async () => ({
      supported: true,
      ratio: 0.5,
      source: 'live',
      fetchedAt: 1,
      plan: null,
      periodEnd: null,
      details: [],
      checkin: quotaCheckin,
    }),
    invalidate: (acc) => invalidates.push(acc?.id ?? acc),
  };
  const claimer = {
    name: 'zcode',
    run: claimerRun ?? (async () => ({ ok: true, status: 'none', claimed: [], credits: 0, message: '' })),
    ...(claimerStatus ? { status: claimerStatus } : {}),
  };
  return { pool, claimer, invalidates };
}

async function quotaOf(t, setup) {
  const dataDir = tmpDataDir(t);
  const { pool, claimer, invalidates } = setup(dataDir);
  const { base } = await startPanel(t, {
    dataDir,
    pools: [pool],
    withKey: false,
    panelOptions: { claimers: { zcode: claimer } },
  });
  const { cookies } = await login(base);
  const res = await panelFetch(base, '/api/pools/zcode/quota', { cookies });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.pool, 'zcode');
  return { body, invalidates, base, cookies, dataDir };
}

// claimer.status 成功且 supported=true：以领取链路为准覆盖 quota 自带的 false
test('quota 路由：claimer.status checkedIn=true 覆盖 quota 自带的 false', async (t) => {
  const { body } = await quotaOf(t, (dir) =>
    makeQuotaPool(dir, {
      quotaCheckin: { checkedIn: false, credits: 0, message: '未签' },
      claimerStatus: async () => ({
        supported: true,
        checkedIn: true,
        claimable: false,
        credits: 42,
        message: '生效额度: daily, promo',
        details: { activeKinds: ['daily', 'promo'], streakDays: 3, active: true },
      }),
    }),
  );
  const row = body.accounts.find((a) => a.account === 'acc-1');
  assert.deepEqual(row.checkin, {
    checkedIn: true,
    credits: 42,
    message: '生效额度: daily, promo',
    supported: true,
    streakDays: 3,
    active: true,
  });
});

// claimer.status 抛错：回落 quota 自带的 checkin（不覆盖、不拖垮路由）
test('quota 路由：claimer.status 抛错 → 回落 quota 的 checkin', async (t) => {
  const { body } = await quotaOf(t, (dir) =>
    makeQuotaPool(dir, {
      quotaCheckin: { checkedIn: false, credits: 7, message: 'quota 自建契约' },
      claimerStatus: async () => {
        throw new Error('签到上游爆炸');
      },
    }),
  );
  const row = body.accounts.find((a) => a.account === 'acc-1');
  assert.deepEqual(row.checkin, { checkedIn: false, credits: 7, message: 'quota 自建契约' });
});

// claimer.status unsupported="国际版无每日签到"：quota 无自带值时 message 保留展示
test('quota 路由：claimer.status supported=false → message 保留（国际版无每日签到）', async (t) => {
  const { body } = await quotaOf(t, (dir) =>
    makeQuotaPool(dir, {
      quotaCheckin: null,
      claimerStatus: async () => ({ supported: false, checkedIn: false, claimable: false, credits: 0, message: '国际版无每日签到' }),
    }),
  );
  const row = body.accounts.find((a) => a.account === 'acc-1');
  assert.equal(row.checkin.checkedIn, false);
  assert.equal(row.checkin.message, '国际版无每日签到');
  assert.equal(row.checkin.supported, false);
});

// claimer.status unsupported 但 quota 自带 checkin：保留 quota 的（覆盖只发生在 supported=true）
test('quota 路由：claimer.status supported=false 且 quota 自带 checkin → 保留 quota 的', async (t) => {
  const { body } = await quotaOf(t, (dir) =>
    makeQuotaPool(dir, {
      quotaCheckin: { checkedIn: false, credits: 5, message: 'quota 自建契约' },
      claimerStatus: async () => ({ supported: false, checkedIn: true, credits: 99, message: '国际版无每日签到' }),
    }),
  );
  const row = body.accounts.find((a) => a.account === 'acc-1');
  assert.deepEqual(row.checkin, { checkedIn: false, credits: 5, message: 'quota 自建契约' });
});

// claim 路由：每个已启用账号 run() 后必须 invalidate；禁用账号跳过
test('claim 路由：claimer.run 后调 pool.quota.invalidate（禁用账号跳过）', async (t) => {
  const dataDir = tmpDataDir(t);
  const claimerRun = async () => ({ ok: true, status: 'claimed', claimed: ['checkin'], credits: 10, message: '签到成功（+10）' });
  const { pool, claimer, invalidates } = makeQuotaPool(dataDir, { claimerRun });
  const { base } = await startPanel(t, { dataDir, pools: [pool], withKey: false, panelOptions: { claimers: { zcode: claimer } } });
  const { cookies } = await login(base);

  const res = await panelFetch(base, '/api/pools/zcode/claim', { method: 'POST', cookies });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.results.length, 1, '只有启用账号被领取');
  assert.deepEqual(invalidates, ['acc-1'], '领取后必须清该账号 quota 缓存');
});

// 名称主显示（Task 3）：displayNameOf 优先级 label → nickname → email → id
test('displayNameOf：label → nickname → email → id 兜底', () => {
  assert.equal(displayNameOf({ label: '标签', nickname: '昵称', email: 'a@x.com', id: 'uuid-1' }), '标签');
  assert.equal(displayNameOf({ nickname: '昵称', email: 'a@x.com', id: 'uuid-1' }), '昵称');
  assert.equal(displayNameOf({ email: 'a@x.com', id: 'uuid-1' }), 'a@x.com');
  assert.equal(displayNameOf({ id: 'uuid-1' }), 'uuid-1');
  assert.equal(displayNameOf(null), '');
});

// quota 路由每行带 label：面板账号列名称主显示，id 次显示
test('quota 路由：响应每行带 label（名称主显示）', async (t) => {
  const { body } = await quotaOf(t, (dir) => makeQuotaPool(dir));
  assert.equal(body.accounts.find((a) => a.account === 'acc-1').label, '测试号');
  assert.equal(body.accounts.find((a) => a.account === 'acc-2').label, '禁用号');
});

// catch 分支（quota.get 抛错）同样要带回 label，否则失败行只能显示 UUID
test('quota 路由：quota.get 抛错的行仍带 label（catch 分支）', async (t) => {
  const dataDir = tmpDataDir(t);
  const pool = makePool('zcode', { dataDir, accounts: [{ id: 'acc-err', nickname: '昵称号', enabled: true }] });
  pool.quota = {
    get: async () => {
      throw new Error('上游炸了');
    },
    invalidate: () => {},
  };
  const { base } = await startPanel(t, { dataDir, pools: [pool], withKey: false });
  const { cookies } = await login(base);
  const res = await panelFetch(base, '/api/pools/zcode/quota', { cookies });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.accounts[0].label, '昵称号');
  assert.match(body.accounts[0].error, /上游炸了/);
});

// claim 路由：每项结果带 label（成功与失败都要）
test('claim 路由：结果带 label（名称主显示）', async (t) => {
  const dataDir = tmpDataDir(t);
  const claimerRun = async () => ({ ok: true, status: 'claimed', claimed: ['checkin'], credits: 10, message: '签到成功（+10）' });
  const { pool, claimer } = makeQuotaPool(dataDir, { claimerRun });
  const { base } = await startPanel(t, { dataDir, pools: [pool], withKey: false, panelOptions: { claimers: { zcode: claimer } } });
  const { cookies } = await login(base);

  const res = await panelFetch(base, '/api/pools/zcode/claim', { method: 'POST', cookies });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.results[0].account, 'acc-1');
  assert.equal(body.results[0].label, '测试号');
});

test('claim 路由：失败结果仍带 label', async (t) => {
  const dataDir = tmpDataDir(t);
  const claimerRun = async () => {
    throw new Error('领取爆炸');
  };
  const { pool, claimer } = makeQuotaPool(dataDir, { claimerRun });
  const { base } = await startPanel(t, { dataDir, pools: [pool], withKey: false, panelOptions: { claimers: { zcode: claimer } } });
  const { cookies } = await login(base);

  const res = await panelFetch(base, '/api/pools/zcode/claim', { method: 'POST', cookies });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.results[0].status, 'failed');
  assert.equal(body.results[0].label, '测试号');
});

// claim-scheduler：整池领取同样联动 invalidate
test('claim-scheduler runAll：claimer.run 后调 pool.quota.invalidate', async (t) => {
  const dataDir = tmpDataDir(t);
  const invalidates = [];
  const pool = makePool('zcode', { dataDir, accounts: [{ id: 'sc-1', label: '调度器号', enabled: true }] });
  pool.quota = {
    get: async () => ({}),
    invalidate: (acc) => invalidates.push(acc?.id ?? acc),
  };
  const claimer = {
    name: 'zcode',
    run: async () => ({ ok: true, status: 'claimed', claimed: ['daily'], credits: 1, message: 'ok' }),
  };
  const sched = createClaimScheduler({
    pools: [pool],
    claimers: { zcode: claimer },
    settingsFile: path.join(dataDir, 'pool-settings.json'),
    dataDir,
  });
  const entries = await sched.runAll();
  assert.equal(entries.length, 1);
  assert.deepEqual(invalidates, ['sc-1']);
});

// 真实 zcode quota 模块：get 两次命中缓存、invalidate(acc) 后重新回源、无参全清
test('zcode quota：invalidate 按账号清缓存，无参全清', async (t) => {
  const stub = await startStub(t, (req, res) => {
    json(res, { code: 0, data: { balances: [{ show_name: '每日赠送', remaining_units: 5, total_units: 10, plan_id: 'daily_free' }] } });
  });
  const acc = { id: 'z-inval', uid: 'u-inval' };
  const quota = createZcodeQuotaCache({ origin: stub.origin });

  assert.equal((await quota.get(acc)).source, 'live');
  assert.equal((await quota.get(acc)).source, 'live');
  assert.equal(stub.requests.length, 1, 'TTL 内第二次 get 命中缓存');

  quota.invalidate(acc);
  await quota.get(acc);
  assert.equal(stub.requests.length, 2, 'invalidate 后重新回源');

  quota.invalidate({ id: 'z-other' }); // 错账号不影响现有缓存
  assert.equal(quota.peek(acc), 0.5);
  quota.invalidate(); // 无参全清
  assert.equal(quota.peek(acc), null);
});

test('zcode quota：失败退避期内 invalidate 后立刻回源', async (t) => {
  let boom = false;
  const stub = await startStub(t, (req, res) => {
    if (boom) {
      res.writeHead(503);
      res.end('down');
      return;
    }
    json(res, { data: { balances: [{ remaining_units: 3, total_units: 10 }] } });
  });
  let clock = 1_760_000_000_000;
  const quota = createZcodeQuotaCache({ origin: stub.origin, ttlMs: 1000, backoffBaseMs: 60_000, now: () => clock });
  const acc = { id: 'z-backoff' };

  const ok = await quota.get(acc);
  assert.equal(ok.source, 'live');
  boom = true;
  clock += 2000; // TTL 已过 → 回源失败 → 进 60s 退避并保留 stale 旧值
  const stale = await quota.get(acc);
  assert.equal(stale.source, 'stale');
  assert.equal(stale.ratio, 0.3);

  clock += 1000; // 退避期内：不再打上游
  await quota.get(acc);
  assert.equal(stub.requests.length, 2, '退避期内不回源');

  quota.invalidate(acc); // 退避计数连同 entry 一起清 → 给回源机会
  const after = await quota.get(acc);
  assert.equal(stub.requests.length, 3, 'invalidate 绕开退避重新请求上游');
  assert.equal(after.source, 'unknown', '上游仍故障：缓存已清无旧值可保留，回 unknown 不外抛');

  boom = false;
  quota.invalidate(acc);
  const live = await quota.get(acc);
  assert.equal(live.source, 'live');
  assert.equal(live.ratio, 0.3);

  quota.invalidate(); // 无参全清
  assert.equal(quota.peek(acc), null);
});

// 前端源码断言（与 panel.frontend.test.js 同风格）：账号页挂载即查 + 领取联动
test('panel 前端：账号页挂载即触发 quota 查询、claimBox 领取后联动刷新', () => {
  const app = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'panel', 'public', 'app.js'), 'utf8');
  const quotaFn = app.slice(app.indexOf('function quotaDetailsBox'), app.indexOf('function claimBox'));
  assert.match(quotaFn, /if \(autoRefresh\) refresh\(\)/, 'quotaDetailsBox 挂载即自动查询');
  assert.match(quotaFn, /box\.refreshQuota = refresh/, '查询封装成 refresh 供外部联动');

  const claimFn = app.slice(app.indexOf('function claimBox'), app.indexOf('function qoderOnboardBox'));
  assert.match(claimFn, /refreshQuota/, 'claimBox 领取动作后联动刷新额度明细');
  assert.match(claimFn, /detail\?\.tried/, '领取结果展示候选摘要（tried）');
});
