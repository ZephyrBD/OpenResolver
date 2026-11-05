import test from 'node:test';
import assert from 'node:assert/strict';
import { startStub } from './helpers/stub.mjs';
import { createQuotaCache } from '../pools/zcode/quota.mjs';
import { sessionIdFor } from '../fingerprint.mjs';

const ACC = { id: 'z1', uid: 'uid-1', deviceId: 'device-abc', jwt: 'jwt-1' };

test('a live balance is parsed into a ratio and sent with x-device-mid', async (t) => {
  const stub = await startStub(t, (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ code: 0, data: { balances: [{ remaining_units: 3.2, total_units: 20 }] } }));
  });
  const quota = createQuotaCache({ origin: stub.origin });

  const result = await quota.get(ACC);

  assert.equal(result.source, 'live');
  assert.ok(Math.abs(result.ratio - 0.16) < 1e-9, `ratio 应约 0.16，实际 ${result.ratio}`);
  assert.equal(typeof result.fetchedAt, 'number');
  assert.equal(stub.requests.length, 1);
  assert.equal(stub.requests[0].method, 'GET');
  assert.equal(stub.requests[0].url, '/api/v1/zcode-plan/billing/balance');
  assert.equal(stub.requests[0].headers['x-device-mid'], 'device-abc');
  assert.equal(stub.requests[0].headers.authorization, `Bearer ${ACC.jwt}`);
  assert.equal(stub.requests[0].headers['x-zcode-app-version'], '3.16.3');
  assert.equal(stub.requests[0].headers['x-session-id'], sessionIdFor(ACC.uid));
});

test('multiple balance buckets are summed', async (t) => {
  const stub = await startStub(t, (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        data: {
          balances: [
            { remaining_units: 1, total_units: 10 },
            { remaining_units: 4, total_units: 10 },
          ],
        },
      }),
    );
  });
  const quota = createQuotaCache({ origin: stub.origin });
  const result = await quota.get(ACC);
  assert.equal(result.ratio, 0.25);
});

test('a failing upstream keeps the old value as stale and backs off', async (t) => {
  let clock = 1_000_000;
  const stub = await startStub(t, (req, res, rec, idx) => {
    if (idx === 0) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ data: { balances: [{ remaining_units: 5, total_units: 10 }] } }));
    }
    res.writeHead(503, { 'content-type': 'text/plain' });
    res.end('upstream down');
  });
  const quota = createQuotaCache({ origin: stub.origin, now: () => clock, ttlMs: 1000, backoffBaseMs: 60_000 });

  const live = await quota.get(ACC);
  assert.equal(live.source, 'live');
  assert.equal(live.ratio, 0.5);

  clock += 2000; // 缓存过期，下一次必须回源
  const stale = await quota.get(ACC);
  assert.equal(stub.requests.length, 2);
  assert.equal(stale.source, 'stale');
  assert.equal(stale.ratio, 0.5);
  assert.ok(stale.error, '失败必须带 error');
  assert.equal(stale.fetchedAt, live.fetchedAt);

  clock += 1000; // 退避期内
  const backedOff = await quota.get(ACC);
  assert.equal(stub.requests.length, 2, '退避期内不得再打上游');
  assert.equal(backedOff.source, 'stale');
  assert.equal(backedOff.ratio, 0.5);

  clock += 60_000; // 首次失败退避 60s 结束
  await quota.get(ACC);
  assert.equal(stub.requests.length, 3, '退避结束后重新回源');
});

test('a failure without a previous value reports unknown', async (t) => {
  const stub = await startStub(t, (req, res) => {
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'bad gateway' } }));
  });
  const quota = createQuotaCache({ origin: stub.origin });
  const result = await quota.get(ACC);
  assert.equal(result.source, 'unknown');
  assert.equal(result.ratio, null);
  assert.ok(result.error);
});

test('a 200 response without balances and no previous value is unknown', async (t) => {
  const stub = await startStub(t, (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ code: 0, data: {} }));
  });
  const quota = createQuotaCache({ origin: stub.origin });
  const result = await quota.get(ACC);
  assert.equal(result.source, 'unknown');
  assert.equal(result.ratio, null);
  assert.ok(result.error);
  assert.equal(quota.peek(ACC), null, '未知额度不参与调度');
});

test('a 200 response without balances but with an old value stays stale', async (t) => {
  let clock = 1_000_000;
  const stub = await startStub(t, (req, res, rec, idx) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    if (idx === 0) return res.end(JSON.stringify({ data: { balances: [{ remaining_units: 2, total_units: 4 }] } }));
    res.end(JSON.stringify({ code: 0, data: {} }));
  });
  const quota = createQuotaCache({ origin: stub.origin, now: () => clock, ttlMs: 1000 });

  assert.equal((await quota.get(ACC)).source, 'live');
  clock += 2000;
  const result = await quota.get(ACC);
  assert.equal(result.source, 'stale');
  assert.equal(result.ratio, 0.5);
  assert.ok(result.error);
});

test('backoff doubles from 60s and caps at 5min', async () => {
  let clock = 1_000_000;
  let calls = 0;
  const quota = createQuotaCache({
    now: () => clock,
    fetchImpl: async () => {
      calls += 1;
      throw new Error('network down');
    },
  });

  await quota.get(ACC); // fail 1 → 60s
  assert.equal(calls, 1);
  clock += 59_000;
  await quota.get(ACC);
  assert.equal(calls, 1, '60s 内不回源');
  clock += 2_000;
  await quota.get(ACC); // fail 2 → 120s
  assert.equal(calls, 2);
  clock += 119_000;
  await quota.get(ACC);
  assert.equal(calls, 2, '120s 内不回源');
  clock += 2_000;
  await quota.get(ACC); // fail 3 → 240s
  assert.equal(calls, 3);
  clock += 239_000;
  await quota.get(ACC);
  assert.equal(calls, 3, '240s 内不回源');
  clock += 2_000;
  await quota.get(ACC); // fail 4 → min(480s, 300s) = 300s
  assert.equal(calls, 4);
  clock += 299_000;
  await quota.get(ACC);
  assert.equal(calls, 4, '封顶 300s 内不回源');
  clock += 2_000;
  await quota.get(ACC); // fail 5 → 仍 300s
  assert.equal(calls, 5);
});

test('a network rejection is contained: unknown result, no throw, same backoff', async () => {
  let clock = 1_000_000;
  let calls = 0;
  const quota = createQuotaCache({
    now: () => clock,
    fetchImpl: () => {
      calls += 1;
      return Promise.reject(new Error('ECONNRESET'));
    },
  });

  const first = await quota.get(ACC);
  assert.equal(first.source, 'unknown');
  assert.equal(first.ratio, null);
  assert.match(first.error, /ECONNRESET/);
  clock += 59_000;
  await quota.get(ACC);
  assert.equal(calls, 1, '退避期内不再打上游');
});

test('the cache is keyed by account id, not by label', async (t) => {
  const stub = await startStub(t, (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: { balances: [{ remaining_units: 1, total_units: 4 }] } }));
  });
  const quota = createQuotaCache({ origin: stub.origin });
  await quota.get({ id: 'z1', label: 'same', uid: 'uid-1', jwt: 'jwt-1' });
  assert.equal(quota.peek({ id: 'z2', label: 'same', uid: 'uid-2', jwt: 'jwt-2' }), null);
  assert.equal(quota.peek({ id: 'z1', label: 'other', uid: 'uid-1', jwt: 'jwt-1' }), 0.25);
});

test('concurrent get() calls for one account share a single upstream request', async (t) => {
  const stub = await startStub(t, (req, res) => {
    setTimeout(() => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: { balances: [{ remaining_units: 1, total_units: 2 }] } }));
    }, 20);
  });
  const quota = createQuotaCache({ origin: stub.origin });

  const results = await Promise.all([quota.get(ACC), quota.get(ACC), quota.get(ACC)]);
  assert.equal(stub.requests.length, 1);
  results.forEach((result) => {
    assert.equal(result.source, 'live');
    assert.equal(result.ratio, 0.5);
  });
});

test('peek returns the last known good ratio synchronously', async (t) => {
  const stub = await startStub(t, (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: { balances: [{ remaining_units: 1, total_units: 4 }] } }));
  });
  const quota = createQuotaCache({ origin: stub.origin });
  assert.equal(quota.peek(ACC), null);
  await quota.get(ACC);
  assert.equal(quota.peek(ACC), 0.25);
});
