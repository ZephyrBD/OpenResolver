import test from 'node:test';
import assert from 'node:assert/strict';
import { startStub } from './helpers/stub.mjs';
import { unwrap, createLoginFlow, pollLoginAccount, accountFromPoll, refreshSession, createTokenManager, EXPIRY_BUFFER_MS } from '../pools/workbuddy/auth.mjs';

const NOW = 1_700_000_000_000;
const now = () => NOW;

test('unwrap：{data:{data:...}} 双层 / {data:...} 单层 / 原样回退（wheel :206-215）', () => {
  assert.deepEqual(unwrap({ data: { data: { a: 1 } } }), { a: 1 });
  assert.deepEqual(unwrap({ data: { a: 1 } }), { a: 1 });
  assert.deepEqual(unwrap({ a: 1 }), { a: 1 });
  assert.equal(unwrap(null), null);
});

test('createLoginFlow：POST /v2/plugin/auth/state?platform=workbuddy，no_auth 头，unwrap 后取 authUrl+state', async (t) => {
  const stub = await startStub(t, (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: { data: { authUrl: 'https://login.example/auth?x=1', state: 'st-1' } } }));
  });
  const flow = createLoginFlow({ endpoint: stub.origin, fetchImpl: (url, opts) => fetch(url, opts) });
  const { state, loginUrl } = await flow();
  assert.equal(state, 'st-1');
  assert.equal(loginUrl, 'https://login.example/auth?x=1');

  const rec = stub.requests[0];
  assert.equal(rec.method, 'POST');
  assert.equal(rec.url, '/v2/plugin/auth/state?platform=workbuddy');
  assert.equal(rec.headers['x-product-code'], 'codebuddy');
  assert.equal(rec.headers['x-no-authorization'], 'true');
  assert.equal(rec.headers['authorization'], undefined);
});

test('auth/state 缺 authUrl 或 state → 抛错', async (t) => {
  const stub = await startStub(t, (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: { data: { state: 'st' } } }));
  });
  const flow = createLoginFlow({ endpoint: stub.origin });
  await assert.rejects(flow, /authUrl/);
});

test('pollLoginAccount：/auth/token → /login/account 两段；未就绪返回 null；就绪返回 {account,auth}', async (t) => {
  let phase = 0;
  const stub = await startStub(t, (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    if (req.url.startsWith('/v2/plugin/auth/token')) {
      phase++;
      if (phase < 2) return void res.end(JSON.stringify({ data: { data: {} } })); // 尚未登录
      res.end(JSON.stringify({ data: { data: { accessToken: 'at-1', refreshToken: 'rt-1', domain: 'd.cn' } } }));
      return;
    }
    if (req.url.startsWith('/v2/plugin/login/account')) {
      const h = req.headers;
      assert.equal(h.authorization, 'Bearer at-1');
      assert.equal(h['x-domain'], 'd.cn');
      res.end(JSON.stringify({ data: { data: { uid: 10001, nickname: 'zephyr', enterpriseId: 'ent-9' } } }));
      return;
    }
    res.end('{}');
  });
  const args = { state: 'st-1', region: 'cn', endpoint: stub.origin };

  assert.equal(await pollLoginAccount(args), null, 'token 未发 → null');
  const out = await pollLoginAccount(args);
  assert.equal(out.auth.accessToken, 'at-1');
  assert.equal(out.account.uid, 10001);

  const acc = accountFromPoll(out);
  assert.equal(acc.id, 'wb-10001');
  assert.equal(acc.jwt, 'at-1');
  assert.equal(acc.refreshToken, 'rt-1');
  assert.equal(acc.domain, 'd.cn');
  assert.equal(acc.enterpriseId, 'ent-9');
  assert.equal(acc.state, 'ok');
});

test('refresh：POST /auth/token/refresh 带 X-Refresh-Token + X-Auth-Refresh-Source: plugin；新 auth 整组返回', async (t) => {
  const stub = await startStub(t, (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: { data: { accessToken: 'at-2', refreshToken: 'rt-2', expiresAt: NOW + 3_600_000 } } }));
  });
  const patch = await refreshSession(
    { id: 'wb-1', uid: '1', jwt: 'at-1', refreshToken: 'rt-1', domain: 'd.cn' },
    { endpoint: stub.origin, now },
  );
  assert.deepEqual(patch, { jwt: 'at-2', refreshToken: 'rt-2', expiresAt: NOW + 3_600_000, domain: 'd.cn' });

  const rec = stub.requests[0];
  assert.equal(rec.method, 'POST');
  assert.equal(rec.url, '/v2/plugin/auth/token/refresh');
  assert.equal(rec.headers['x-refresh-token'], 'rt-1');
  assert.equal(rec.headers['x-auth-refresh-source'], 'plugin');
  assert.equal(rec.headers['authorization'], undefined, 'refresh 请求不带 Bearer（access:false）');
  assert.deepEqual(JSON.parse(rec.body), {});
});

test('refresh：无 refreshToken 返回 null；payload 缺 accessToken 返回 null', async (t) => {
  const stub = await startStub(t, (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: { data: {} } }));
  });
  assert.equal(await refreshSession({ id: 'a' }, { endpoint: stub.origin, now }), null);
  assert.equal(await refreshSession({ id: 'a', refreshToken: 'rt' }, { endpoint: stub.origin, now }), null);
});

test('单飞锁：并发 10 次只 1 次刷新在飞；提前 5 分钟刷新；失败重试一次', async (t) => {
  let hits = 0;
  const stub = await startStub(t, async (req, res) => {
    hits++;
    await new Promise((r) => setTimeout(r, 20));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: { data: { accessToken: `at-${hits}`, refreshToken: 'rt-2' } } }));
  });
  const tokens = createTokenManager({ endpoint: stub.origin, now });

  const acc = { id: 'a1', jwt: '', refreshToken: 'rt-1', expiresAt: 0 };
  const results = await Promise.all(Array.from({ length: 10 }, () => tokens.accessFor(acc)));
  assert.equal(hits, 1, '并发 10 次只 1 次刷新');
  assert.equal(new Set(results.map((r) => r.token)).size, 1);
  assert.equal(results[0].patch.jwt, 'at-1', 'patch 带新 token，调用方整组落盘');
  assert.equal(results[0].patch.expiresAt, NOW + 24 * 3_600_000, '无 expiresAt → 24h 续期窗口');

  // 新鲜 token 不刷新
  const fresh = await tokens.accessFor({ id: 'b', jwt: 'ok', refreshToken: 'rt', expiresAt: NOW + 10 * 60_000 });
  assert.equal(fresh.token, 'ok');
  assert.equal(fresh.patch, null);
  assert.equal(hits, 1);
  assert.equal(EXPIRY_BUFFER_MS, 5 * 60_000);

  // 距过期 4 分钟 → 刷新
  const stale = await tokens.accessFor({ id: 'c', jwt: 'old', refreshToken: 'rt', expiresAt: NOW + 4 * 60_000 });
  assert.equal(stale.token, 'at-2');

  // 失败重试一次
  let fails = 0;
  const failStub = await startStub(t, (req, res) => {
    fails++;
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end('{"code":401,"msg":"refresh token invalid"}');
  });
  const dead = createTokenManager({ endpoint: failStub.origin, now });
  const out = await dead.accessFor({ id: 'd', jwt: '', refreshToken: 'rt-dead', expiresAt: 0 });
  assert.equal(out.token, null);
  assert.equal(out.patch, null);
  assert.equal(fails, 2, '失败重试一次');
});
