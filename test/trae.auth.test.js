import test from 'node:test';
import assert from 'node:assert/strict';
import { startStub } from './helpers/stub.mjs';
import { decodeCallback, exchangeToken, fetchUserInfo, createTokenManager, EXPIRY_BUFFER_MS } from '../pools/trae/auth.mjs';

const NOW = 1_700_000_000_000;
const now = () => NOW;

test('回调解码：parse_qs 一层 + 容错 unquote 第二层（login.sh parse_json_param 逻辑）', () => {
  const userInfo = { UserID: '37396015402', ScreenName: 'zephyr' };
  const userJwt = { Token: 'jwt-x', RefreshToken: 'rt-fallback' };
  // userInfo 双层编码（URLSearchParams 编一层，JSON 里再带一层 %22）
  const doubly = encodeURIComponent(JSON.stringify(userInfo));
  const url = `http://127.0.0.1:18080/authorize?refreshToken=rt-1&userInfo=${doubly}&userJwt=${encodeURIComponent(JSON.stringify(userJwt))}`;
  const out = decodeCallback(url);
  assert.equal(out.refreshToken, 'rt-1');
  assert.deepEqual(out.userInfo, userInfo);
  assert.deepEqual(out.userJwt, userJwt);
  assert.equal(out.uid, '37396015402');
  assert.equal(out.nickname, 'zephyr');
  assert.equal(out.jwtToken, 'jwt-x');

  // 双层 %22 情形：参数值本身还是 URL 编码的 JSON（unquote 两次才出对象）
  const twice = encodeURIComponent(encodeURIComponent(JSON.stringify(userInfo)));
  const out2 = decodeCallback(`http://x/cb?userInfo=${twice}`);
  assert.deepEqual(out2.userInfo, userInfo);
});

test('回调解码：缺 refreshToken 时回退 userJwt.RefreshToken', () => {
  const out = decodeCallback(
    `http://x/cb?userJwt=${encodeURIComponent(JSON.stringify({ Token: 't', RefreshToken: 'r' }))}`,
  );
  assert.equal(out.refreshToken, 'r');
});

test('ExchangeToken：体 {ClientID,RefreshToken,ClientSecret:"-",UserID:""}、UA Trae/0.1.61、Result 字段解析', async (t) => {
  const stub = await startStub(t, (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        Result: { Token: 'jwt-1', RefreshToken: 'rt-2', TokenExpireAt: NOW + 86_400_000 },
      }),
    );
  });
  const out = await exchangeToken('rt-1', {
    fetchImpl: (url, opts) => fetch(`${stub.origin}/exchange`, opts),
    now,
  });
  assert.equal(out.token, 'jwt-1');
  assert.equal(out.refreshToken, 'rt-2');

  const rec = stub.requests[0];
  const body = JSON.parse(rec.body);
  assert.deepEqual(body, { ClientID: 'en1oxy7wnw8j9n', RefreshToken: 'rt-1', ClientSecret: '-', UserID: '' });
  assert.match(rec.headers['user-agent'], /^Trae\/0\.1\.\d+$/);
  assert.equal(rec.headers['content-type'], 'application/json');
});

test('TokenExpireAt 三态：毫秒原样、秒×1000、缺失用 TokenExpireDuration（默认 1209600 秒）', async (t) => {
  const cases = [
    { Result: { Token: 't', TokenExpireAt: NOW + 1000 }, expect: NOW + 1000 },
    { Result: { Token: 't', TokenExpireAt: Math.floor((NOW + 2_000_000) / 1000) }, expect: NOW + 2_000_000 },
    { Result: { Token: 't', TokenExpireDuration: 3600 }, expect: NOW + 3_600_000 },
    { Result: { Token: 't' }, expect: NOW + 1_209_600_000 },
  ];
  for (const [i, c] of cases.entries()) {
    const stub = await startStub(t, (req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(c));
    });
    const out = await exchangeToken('rt', { fetchImpl: (url, opts) => fetch(`${stub.origin}/e${i}`, opts), now });
    assert.equal(out.expiresAt, c.expect, `case ${i}`);
  }
});

test('refreshToken 轮换立即落盘：onRefresh 收到 patch {jwt,refreshToken,expiresAt}', async (t) => {
  const stub = await startStub(t, (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ Result: { Token: 'jwt-new', RefreshToken: 'rt-new', TokenExpireAt: NOW + 1e9 } }));
  });
  const persisted = [];
  const tokens = createTokenManager({
    fetchImpl: (url, opts) => fetch(`${stub.origin}/exchange`, opts),
    now,
    onRefresh: (id, patch) => persisted.push([id, patch]),
  });
  const acc = { id: 'a1', jwt: 'jwt-old', refreshToken: 'rt-old', expiresAt: 0 };
  const { token, patch } = await tokens.accessFor(acc);
  assert.equal(token, 'jwt-new');
  assert.deepEqual(patch, { jwt: 'jwt-new', refreshToken: 'rt-new', expiresAt: NOW + 1e9 });
  assert.deepEqual(persisted, [['a1', patch]], '轮换的 refreshToken 必须立即回调落盘');
});

test('单飞锁：并发 10 次只 1 次 ExchangeToken 在飞，全部拿到同一 token', async (t) => {
  let hits = 0;
  const stub = await startStub(t, async (req, res) => {
    hits++;
    await new Promise((r) => setTimeout(r, 20));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ Result: { Token: `jwt-${hits}`, RefreshToken: 'rt', TokenExpireAt: NOW + 1e9 } }));
  });
  const tokens = createTokenManager({ fetchImpl: (url, opts) => fetch(`${stub.origin}/e`, opts), now });
  const acc = { id: 'a1', jwt: '', refreshToken: 'rt', expiresAt: 0 };
  const results = await Promise.all(Array.from({ length: 10 }, () => tokens.accessFor(acc)));
  assert.equal(hits, 1, '并发 10 次只 1 次交换');
  assert.equal(new Set(results.map((r) => r.token)).size, 1);
});

test('提前 5 分钟刷新：now >= expiresAt - 5min 触发交换；新鲜 token 不触发', async (t) => {
  const stub = await startStub(t, (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ Result: { Token: 'jwt-2', TokenExpireAt: NOW + 1e9 } }));
  });
  const tokens = createTokenManager({ fetchImpl: (url, opts) => fetch(`${stub.origin}/e`, opts), now });
  const base = stub.requests.length;

  // 距过期还有 10 分钟（> 5min buffer）→ 不刷新
  const fresh = await tokens.accessFor({ id: 'a', jwt: 'jwt-ok', refreshToken: 'rt', expiresAt: NOW + 10 * 60_000 });
  assert.equal(fresh.token, 'jwt-ok');
  assert.equal(fresh.patch, null);
  assert.equal(stub.requests.length, base);

  // 距过期 4 分钟（< 5min buffer）→ 刷新
  const stale = await tokens.accessFor({ id: 'b', jwt: 'jwt-old', refreshToken: 'rt', expiresAt: NOW + 4 * 60_000 });
  assert.equal(stale.token, 'jwt-2');
  assert.equal(EXPIRY_BUFFER_MS, 5 * 60_000);
});

test('刷新失败重试一次，再失败返回 null（调用方标 needs_login）', async (t) => {
  let hits = 0;
  const stub = await startStub(t, (req, res) => {
    hits++;
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ code: 20101, message: 'refresh token is invalid' }));
  });
  const tokens = createTokenManager({ fetchImpl: (url, opts) => fetch(`${stub.origin}/e`, opts), now });
  const out = await tokens.accessFor({ id: 'a', jwt: '', refreshToken: 'rt-dead', expiresAt: 0 });
  assert.equal(out.token, null);
  assert.equal(out.patch, null);
  assert.equal(hits, 2, '失败重试一次（共 2 次尝试）');
});

test('GetUserInfo：POST {ReqSource:"IDE",IDEVersion} + x-cloudide-token 头', async (t) => {
  const stub = await startStub(t, (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ Result: { UserID: 'u-1', ScreenName: 'nick', EnterpriseID: 'ent-1' } }));
  });
  const info = await fetchUserInfo('jwt-1', {
    fetchImpl: (url, opts) => fetch(`${stub.origin}/userinfo`, opts),
  });
  assert.deepEqual(info, { userID: 'u-1', nickname: 'nick', enterpriseId: 'ent-1' });
  const rec = stub.requests[0];
  assert.equal(rec.headers['x-cloudide-token'], 'jwt-1');
  assert.deepEqual(JSON.parse(rec.body), { ReqSource: 'IDE', IDEVersion: '0.1.61' });
});
