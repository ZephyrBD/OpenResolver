import test from 'node:test';
import assert from 'node:assert/strict';
import { startGateway, seedDb } from './helpers/gateway.mjs';

/** 构造一个只暴露 balance 路由所需面的池：可带 quota 桩与 scheduler 桩。 */
function stubPool(name, { quota, accounts, settings } = {}) {
  return {
    name,
    type: 'pool',
    accounts: accounts ?? [],
    models: () => [],
    ...(quota ? { quota } : {}),
    ...(settings ? { scheduler: { settings } } : {}),
  };
}

/** quota 桩：get(acc) 返回固定 details[]。 */
function quotaOf(details) {
  return {
    get: async () => ({
      supported: true,
      ratio: 0.5,
      source: 'test',
      fetchedAt: 0,
      plan: null,
      periodEnd: null,
      details,
      checkin: null,
    }),
  };
}

const credit = (remaining, name = '套餐', unit = 'credits') => ({ name, remaining, total: 100, unit, percent: null });

/** 默认顺序与 boot 一致：zcode, qoder, qoder-cn, trae, workbuddy, workbuddy-cn, codearts。 */
const ALL_POOLS = [
  'zcode',
  'qoder',
  'qoder-cn',
  'trae',
  'workbuddy',
  'workbuddy-cn',
  'codearts',
];

test('GET /user/balance rejects a missing key when open mode is off', async (t) => {
  const { base } = await startGateway(t, { config: { openMode: false }, pools: [stubPool('zcode')] });

  const res = await fetch(`${base}/user/balance`);
  const body = await res.json();

  assert.equal(res.status, 401);
  assert.equal(body.error.type, 'authentication_error');
});

test('GET /user/balance rejects a bad key with the same error shape as /v1', async (t) => {
  const { base } = await startGateway(t, { config: { openMode: false }, pools: [stubPool('zcode')] });

  const bearer = await fetch(`${base}/user/balance`, { headers: { authorization: 'Bearer zsk_bogus' } });
  assert.equal(bearer.status, 401);
  assert.equal((await bearer.json()).error.type, 'authentication_error');

  const xapi = await fetch(`${base}/user/balance`, { headers: { 'x-api-key': 'zsk_bogus' } });
  assert.equal(xapi.status, 401);
});

test('GET /user/balance answers 200 with the response shape for a valid key', async (t) => {
  const { db, full } = seedDb({ name: 'dev' });
  const { base } = await startGateway(t, { db, config: { openMode: false }, pools: [stubPool('zcode')] });

  const res = await fetch(`${base}/user/balance`, { headers: { authorization: `Bearer ${full}` } });
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.equal(body.is_active, true);
  assert.equal(body.unit, 'token');
  assert.ok(Number.isFinite(body.fetched_at) && body.fetched_at > 0);
  assert.equal(body.balance, 0);
  assert.deepEqual(Object.keys(body.pools), ['zcode']);
});

test('GET /user/balance lists all 7 pool names even when pools lack quota modules', async (t) => {
  const { db, full } = seedDb({ name: 'dev' });
  const pools = ALL_POOLS.map((name) => ({ name, type: 'pool', models: () => [] }));
  const { base } = await startGateway(t, { db, config: { openMode: false }, pools });

  const res = await fetch(`${base}/user/balance`, { headers: { authorization: `Bearer ${full}` } });
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.deepEqual(Object.keys(body.pools), ALL_POOLS);
  for (const name of ALL_POOLS) assert.equal(body.pools[name], 0);
  assert.equal(body.balance, 0);
});

test('GET /user/balance sums credits per pool and applies the default conversion rates', async (t) => {
  const { db, full } = seedDb({ name: 'dev' });
  const pools = [
    stubPool('zcode', {
      quota: quotaOf([credit(500, 'token', 'token'), { remaining: null }]),
      accounts: [{ id: 'z1' }],
    }),
    stubPool('qoder', { quota: quotaOf([credit(10, 'c1', 'credit'), credit(5, 'c2', 'credits')]), accounts: [{ id: 'q1' }] }),
    stubPool('qoder-cn', { quota: quotaOf([credit(2, 'c', 'credit')]), accounts: [{ id: 'qn' }] }),
    stubPool('trae', { quota: quotaOf([credit(7, 't', 'credits')]), accounts: [{ id: 't1' }] }),
    stubPool('workbuddy', { quota: quotaOf([credit(60), credit(40)]), accounts: [{ id: 'w1' }] }),
    stubPool('workbuddy-cn', { quota: quotaOf([credit(100)]), accounts: [{ id: 'wn' }] }),
    stubPool('codearts', { quota: quotaOf([credit(999, '基础积分')]), accounts: [{ id: 'c1' }] }),
  ];
  const { base } = await startGateway(t, { db, config: { openMode: false }, pools });

  const res = await fetch(`${base}/user/balance`, { headers: { authorization: `Bearer ${full}` } });
  const body = await res.json();

  const wb100x1265 = Math.round(100 * 1.265); // 127（默认 WB 比率 ×1.265）
  assert.equal(body.pools.zcode, 500, 'zcode 明细本身是 token，×1；null remaining 记 0');
  assert.equal(body.pools.qoder, 15, 'qoder 默认 1:1');
  assert.equal(body.pools['qoder-cn'], 2);
  assert.equal(body.pools.trae, 7);
  assert.equal(body.pools.workbuddy, wb100x1265);
  assert.equal(body.pools['workbuddy-cn'], wb100x1265);
  assert.equal(body.pools.codearts, 999, 'codearts 积分按默认 1:1 折算 token');
  assert.equal(
    body.balance,
    500 + 15 + 2 + 7 + wb100x1265 * 2 + 999,
    'balance = 各池折算 token 剩余之和',
  );
});

test('GET /user/balance honours rates from pools[0].scheduler.settings', async (t) => {
  const { db, full } = seedDb({ name: 'dev' });
  const pools = [
    stubPool('zcode', {
      quota: quotaOf([{ remaining: 10 }]),
      accounts: [{ id: 'z1' }],
      settings: { wbCreditTokensRate: 2, qoderCreditTokensRate: 3 },
    }),
    stubPool('workbuddy', { quota: quotaOf([credit(100)]), accounts: [{ id: 'w1' }] }),
    stubPool('qoder', { quota: quotaOf([credit(10, 'c', 'credit')]), accounts: [{ id: 'q1' }] }),
  ];
  const { base } = await startGateway(t, { db, config: { openMode: false }, pools });

  const res = await fetch(`${base}/user/balance`, { headers: { authorization: `Bearer ${full}` } });
  const body = await res.json();

  assert.equal(body.pools.workbuddy, 200, 'WB 比率取自调度器设置 2');
  assert.equal(body.pools.qoder, 30, 'Qoder 比率取自调度器设置 3');
  assert.equal(body.balance, 200 + 30 + 10);
});

test('GET /user/balance honours codeartsCreditTokensRate (credits × rate)', async (t) => {
  const { db, full } = seedDb({ name: 'dev' });
  const pools = [
    stubPool('zcode', { settings: { codeartsCreditTokensRate: 2 } }),
    stubPool('codearts', {
      quota: quotaOf([credit(120, '基础积分'), credit(80, '按需积分')]),
      accounts: [{ id: 'c1' }, { id: 'c2' }],
    }),
  ];
  const { base } = await startGateway(t, { db, config: { openMode: false }, pools });

  const res = await fetch(`${base}/user/balance`, { headers: { authorization: `Bearer ${full}` } });
  const body = await res.json();

  // 两个账号各 (120+80) = 200，比率 2 → 800（两号明细求和后再折算）
  assert.equal(body.pools.codearts, 800, 'codearts 积分按 codeartsCreditTokensRate 折算');
  assert.equal(body.balance, 800);
});

test('GET /user/balance skips disabled accounts and counts the rest', async (t) => {
  const { db, full } = seedDb({ name: 'dev' });
  const pools = [
    stubPool('zcode', {
      quota: quotaOf([credit(10, 'a'), credit(20, 'b')]),
      accounts: [
        { id: 'off', enabled: false, label: '禁用号' },
        { id: 'on', label: '启用号' },
      ],
    }),
    // 账号级覆盖检查需要按账号返回不同明细的桩
    {
      ...stubPool('qoder', { accounts: [{ id: 'a1' }, { id: 'a2' }] }),
      quota: {
        get: async (acc) => quotaOf([credit(acc.id === 'a1' ? 5 : 0, 'c', 'credit')]).get(acc),
      },
    },
  ];
  const { base } = await startGateway(t, { db, config: { openMode: false }, pools });

  const res = await fetch(`${base}/user/balance`, { headers: { authorization: `Bearer ${full}` } });
  const body = await res.json();

  assert.equal(body.pools.zcode, 30, '只算启用号的明细');
  assert.equal(body.pools.qoder, 5);
});

test('GET /user/balance survives a pool whose quota.get throws (contributes 0, still 200)', async (t) => {
  const { db, full } = seedDb({ name: 'dev' });
  const errorQuota = { get: async () => { throw new Error('上游 500'); } };
  const pools = [
    stubPool('zcode', { quota: quotaOf([credit(42, 't', 'token')]), accounts: [{ id: 'z1' }] }),
    stubPool('qoder', { quota: errorQuota, accounts: [{ id: 'q1' }] }),
  ];
  const { base } = await startGateway(t, { db, config: { openMode: false }, pools });

  const res = await fetch(`${base}/user/balance`, { headers: { authorization: `Bearer ${full}` } });
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.equal(body.pools.qoder, 0, '抛错的池贡献 0');
  assert.equal(body.balance, 42);
});
