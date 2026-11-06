import test from 'node:test';
import assert from 'node:assert/strict';
import { startGateway, seedDb } from './helpers/gateway.mjs';

/** 构造一个只暴露 balance 路由所需面的池：可带 quota 桩与账号列表。 */
function stubPool(name, { quota, accounts } = {}) {
  return {
    name,
    type: 'pool',
    accounts: accounts ?? [],
    models: () => [],
    ...(quota ? { quota } : {}),
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

const credit = (remaining, total = 100, name = '套餐', unit = 'credits') => ({ name, remaining, total, unit, percent: null });

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

test('GET /v1/pool/balance rejects a missing key when open mode is off', async (t) => {
  const { base } = await startGateway(t, { config: { openMode: false }, pools: [stubPool('zcode')] });

  const res = await fetch(`${base}/v1/pool/balance`);
  const body = await res.json();

  assert.equal(res.status, 401);
  assert.equal(body.error.type, 'authentication_error');
});

test('GET /v1/pool/balance rejects a bad key with the same error shape as /v1', async (t) => {
  const { base } = await startGateway(t, { config: { openMode: false }, pools: [stubPool('zcode')] });

  const bearer = await fetch(`${base}/v1/pool/balance`, { headers: { authorization: 'Bearer zsk_bogus' } });
  assert.equal(bearer.status, 401);
  assert.equal((await bearer.json()).error.type, 'authentication_error');

  const xapi = await fetch(`${base}/v1/pool/balance`, { headers: { 'x-api-key': 'zsk_bogus' } });
  assert.equal(xapi.status, 401);
});

test('GET /v1/pool/balance answers 200 with the response shape for a valid key', async (t) => {
  const { db, full } = seedDb({ name: 'dev' });
  const { base } = await startGateway(t, { db, config: { openMode: false }, pools: [stubPool('zcode')] });

  const res = await fetch(`${base}/v1/pool/balance`, { headers: { authorization: `Bearer ${full}` } });
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.ok(Number.isFinite(body.fetched_at) && body.fetched_at > 0);
  assert.deepEqual(body.pools, [{ name: 'zcode', unit: 'token', balance: 0, total: null, accounts: 0, ok: 0 }]);
});

test('GET /user/balance is gone (404), no legacy path compatibility', async (t) => {
  const { db, full } = seedDb({ name: 'dev' });
  const { base } = await startGateway(t, { db, config: { openMode: false }, pools: [stubPool('zcode')] });

  const res = await fetch(`${base}/user/balance`, { headers: { authorization: `Bearer ${full}` } });
  assert.equal(res.status, 404);
});

test('GET /v1/pool/balance lists every pool with its own unit even when pools lack quota modules', async (t) => {
  const { db, full } = seedDb({ name: 'dev' });
  const pools = ALL_POOLS.map((name) => ({ name, type: 'pool', models: () => [] }));
  const { base } = await startGateway(t, { db, config: { openMode: false }, pools });

  const res = await fetch(`${base}/v1/pool/balance`, { headers: { authorization: `Bearer ${full}` } });
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.deepEqual(body.pools.map((p) => p.name), ALL_POOLS);
  for (const p of body.pools) {
    assert.equal(p.balance, 0);
    assert.equal(p.accounts, 0);
    assert.equal(p.ok, 0);
  }
  const byName = Object.fromEntries(body.pools.map((p) => [p.name, p]));
  for (const name of ['zcode', 'trae']) assert.equal(byName[name].unit, 'token');
  for (const name of ['workbuddy', 'workbuddy-cn', 'qoder', 'qoder-cn', 'codearts']) {
    assert.equal(byName[name].unit, 'credit');
  }
});

test('GET /v1/pool/balance sums raw remaining and total per pool without any conversion rate', async (t) => {
  const { db, full } = seedDb({ name: 'dev' });
  const pools = [
    stubPool('zcode', {
      quota: quotaOf([credit(500, 2000, 'token', 'token'), { remaining: null, total: 200 }]),
      accounts: [{ id: 'z1' }],
    }),
    stubPool('qoder', { quota: quotaOf([credit(10, 50, 'c1', 'credit'), credit(5, 50, 'c2', 'credits')]), accounts: [{ id: 'q1' }] }),
    stubPool('trae', { quota: quotaOf([credit(7, 70, 't', 'credits')]), accounts: [{ id: 't1' }] }),
    stubPool('workbuddy', { quota: quotaOf([credit(60, 80), credit(40, 120)]), accounts: [{ id: 'w1' }] }),
    stubPool('codearts', { quota: quotaOf([credit(999, 1000, '基础积分')]), accounts: [{ id: 'c1' }] }),
  ];
  const { base } = await startGateway(t, { db, config: { openMode: false }, pools });

  const res = await fetch(`${base}/v1/pool/balance`, { headers: { authorization: `Bearer ${full}` } });
  const body = await res.json();

  const byName = Object.fromEntries(body.pools.map((p) => [p.name, p]));
  assert.equal(byName.zcode.balance, 500, 'zcode 原始求和；null remaining 记 0，不折算');
  assert.equal(byName.zcode.total, 2200, 'total 同轮循环求和，null remaining 的项 total 照算');
  assert.equal(byName.zcode.unit, 'token');
  assert.equal(byName.zcode.ok, 1);
  assert.equal(byName.qoder.balance, 15, 'credit 池同样原始求和，不做 credit→token 换算');
  assert.equal(byName.qoder.total, 100);
  assert.equal(byName.qoder.unit, 'credit');
  assert.equal(byName.trae.balance, 7);
  assert.equal(byName.trae.total, 70);
  assert.equal(byName.trae.unit, 'token');
  assert.equal(byName.workbuddy.balance, 100, 'workbuddy 明细 credit 原样输出，不乘折算率');
  assert.equal(byName.workbuddy.total, 200, 'total 跨明细项求和（80 + 120）');
  assert.equal(byName.workbuddy.unit, 'credit');
  assert.equal(byName.codearts.balance, 999);
  assert.equal(byName.codearts.total, 1000);
  assert.equal(byName.codearts.unit, 'credit');
});

test('GET /v1/pool/balance reports total null when no detail item carries a finite total', async (t) => {
  const { db, full } = seedDb({ name: 'dev' });
  const pools = [
    // 整池所有明细都缺 total / total 非有限数 → total 必须是 null（前端只显示可用量）
    stubPool('workbuddy', {
      quota: quotaOf([{ name: 'a', remaining: 10, total: null }, { name: 'b', remaining: 5 }, { name: 'c', remaining: 3, total: 'x' }]),
      accounts: [{ id: 'w1' }],
    }),
    // 同一池子里部分项有 total → 正常求和，不因个别项缺失而置 null
    stubPool('qoder', {
      quota: quotaOf([{ name: 'p', remaining: 4, total: 10 }, { name: 'q', remaining: 1, total: null }]),
      accounts: [{ id: 'q1' }],
    }),
  ];
  const { base } = await startGateway(t, { db, config: { openMode: false }, pools });

  const res = await fetch(`${base}/v1/pool/balance`, { headers: { authorization: `Bearer ${full}` } });
  const body = await res.json();

  const byName = Object.fromEntries(body.pools.map((p) => [p.name, p]));
  assert.equal(byName.workbuddy.balance, 18, '缺 total 不影响 balance 求和');
  assert.equal(byName.workbuddy.total, null, '一个 finite total 都没拿到 → null');
  assert.equal(byName.workbuddy.ok, 1);
  assert.equal(byName.qoder.balance, 5);
  assert.equal(byName.qoder.total, 10, '个别项缺 total 只跳过该项，不整池置 null');
});

test('GET /v1/pool/balance only lists the pools the key is allowed to see', async (t) => {
  const { db, full } = seedDb({ name: 'dev', pools: ['workbuddy'] });
  const pools = [
    stubPool('zcode', { quota: quotaOf([credit(500, 'token', 'token')]), accounts: [{ id: 'z1' }] }),
    stubPool('workbuddy', { quota: quotaOf([credit(60), credit(40)]), accounts: [{ id: 'w1' }] }),
  ];
  const { base } = await startGateway(t, { db, config: { openMode: false }, pools });

  const res = await fetch(`${base}/v1/pool/balance`, { headers: { authorization: `Bearer ${full}` } });
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.deepEqual(body.pools.map((p) => p.name), ['workbuddy'], 'key 只授权了 workbuddy，就只见 workbuddy');
  assert.equal(body.pools[0].unit, 'credit');
  assert.equal(body.pools[0].balance, 100);
});

test('GET /v1/pool/balance skips disabled accounts and counts accounts/ok', async (t) => {
  const { db, full } = seedDb({ name: 'dev' });
  const pools = [
    stubPool('zcode', {
      quota: quotaOf([credit(10), credit(20)]),
      accounts: [
        { id: 'off', enabled: false, label: '禁用号' },
        { id: 'on', label: '启用号' },
      ],
    }),
    stubPool('workbuddy', {
      quota: quotaOf([credit(5, 50, 'c', 'credit')]),
      accounts: [{ id: 'w1' }, { id: 'w2', enabled: false }, { id: 'w3' }],
    }),
  ];
  const { base } = await startGateway(t, { db, config: { openMode: false }, pools });

  const res = await fetch(`${base}/v1/pool/balance`, { headers: { authorization: `Bearer ${full}` } });
  const body = await res.json();

  const byName = Object.fromEntries(body.pools.map((p) => [p.name, p]));
  assert.equal(byName.zcode.accounts, 1);
  assert.equal(byName.zcode.ok, 1);
  assert.equal(byName.zcode.balance, 30, '只算启用号的明细');
  assert.equal(byName.workbuddy.accounts, 2, 'enabled:false 的账号不计入 accounts');
  assert.equal(byName.workbuddy.ok, 2);
  assert.equal(byName.workbuddy.balance, 10, '两个启用号各 5');
});

test('GET /v1/pool/balance survives a pool whose quota.get throws (ok 0, balance 0, still 200)', async (t) => {
  const { db, full } = seedDb({ name: 'dev' });
  const errorQuota = { get: async () => { throw new Error('上游 500'); } };
  const pools = [
    stubPool('zcode', { quota: quotaOf([credit(42, 100, 't', 'token')]), accounts: [{ id: 'z1' }] }),
    stubPool('qoder', { quota: errorQuota, accounts: [{ id: 'q1' }] }),
  ];
  const { base } = await startGateway(t, { db, config: { openMode: false }, pools });

  const res = await fetch(`${base}/v1/pool/balance`, { headers: { authorization: `Bearer ${full}` } });
  const body = await res.json();

  assert.equal(res.status, 200);
  const byName = Object.fromEntries(body.pools.map((p) => [p.name, p]));
  assert.equal(byName.qoder.ok, 0, '抛错的账号不算 ok');
  assert.equal(byName.qoder.balance, 0, '抛错的池贡献 0');
  assert.equal(byName.zcode.balance, 42);
});
