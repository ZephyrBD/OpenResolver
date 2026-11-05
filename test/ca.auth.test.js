// ca.auth.test.js — PKCE S256 向量（RFC 7636）、授权 URL、ticket 轮询、
// exchange/refresh 请求体与 DPoP 头、终态失效分类、单飞锁。

import test from 'node:test';
import assert from 'node:assert/strict';
import { startStub } from './helpers/stub.mjs';
import {
  pkceChallenge, createPkce, buildAuthorizeURL, createLoginFlow,
  exchangeCode, refreshToken, pollTicket, isRefreshTokenExpired,
  accountFromToken, expiresAtMsOf, createTokenManager, EXPIRY_BUFFER_MS,
  LOGIN_CONFIG_DEFAULTS,
} from '../pools/codearts/auth.mjs';
import { newDpopPrivateJwk } from '../pools/codearts/dpop.mjs';
import { verifyDpopProof } from '../pools/codearts/dpop.mjs';
import { EP_OAUTH_TOKENS } from '../pools/codearts/constants.mjs';

const CFG = { ...LOGIN_CONFIG_DEFAULTS, stsHost: 'https://sts.test', snapManager: 'https://sm.test', portalHost: 'https://portal.test/portal' };
const NOW = 1_700_000_000_000;
const now = () => NOW;

test('PKCE：RFC 7636 附录 B S256 向量', () => {
  const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
  assert.equal(pkceChallenge(verifier), 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  const { codeVerifier, codeChallenge } = createPkce();
  assert.notEqual(codeVerifier, codeChallenge);
  assert.equal(codeChallenge, pkceChallenge(codeVerifier), 'challenge 可由 verifier 复算');
});

test('buildAuthorizeURL：query 逐项对齐 vendor upstream_test.go:193-211', () => {
  const url = new URL(buildAuthorizeURL(CFG, { ticketId: 'ticket', codeChallenge: 'challenge', port: 43123 }));
  const q = url.searchParams;
  assert.equal(url.origin + url.pathname, 'https://portal.test/portal/authorize');
  assert.equal(q.get('theme'), '2');
  assert.equal(q.get('locale'), 'zh-cn');
  assert.equal(q.get('uri_scheme'), 'codearts-agent');
  assert.equal(q.get('client_id'), 'codearts-agent');
  assert.equal(q.get('port'), '43123');
  assert.equal(q.get('code_challenge'), 'challenge');
  assert.equal(q.get('code_challenge_method'), 'SHA-256');
  assert.equal(q.get('ticket_id'), 'ticket');
  assert.equal(q.get('plugin-name'), 'snap_AIIDE');
  assert.equal(q.get('plugin-version'), '5.2.0');
});

test('createLoginFlow：一次生成 PKCE + DPoP 密钥对 + ticket/secret + 授权链接', () => {
  const flow = createLoginFlow({ cfg: CFG, port: 1455 });
  assert.match(flow.authorizeUrl, /^https:\/\/portal\.test\/portal\/authorize\?/);
  assert.match(flow.ticketId, /^[0-9a-f]{32}$/);
  assert.match(flow.secret, /^[0-9a-f]{32}$/);
  assert.equal(flow.port, 1455);
  assert.equal(flow.dpopJwk.crv, 'P-256');
  assert.ok(flow.dpopJwk.d, '私钥 JWK 必须可持久化');
  assert.ok(flow.codeVerifier);
});

test('exchangeCode：POST {sts}/v1/oauth2/tokens form + DPoP 头（vendor TestExchangeCodeEndpoint）', async (t) => {
  const jwk = newDpopPrivateJwk();
  const stub = await startStub(t, (req, res, rec) => {
    assert.equal(req.url, EP_OAUTH_TOKENS);
    assert.equal(req.headers['content-type'], 'application/x-www-form-urlencoded');
    assert.ok(req.headers.dpop, 'missing DPoP header');
    const form = new URLSearchParams(rec.body);
    assert.equal(form.get('grant_type'), 'authorization_code');
    assert.equal(form.get('code'), 'code-1');
    assert.equal(form.get('code_verifier'), 'verifier-1');
    assert.equal(form.get('client_id'), 'codearts-agent');
    assert.equal(form.get('redirect_uri'), 'http://127.0.0.1:9999/oauth/callback');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      user_id: 'u1', user_name: 'n1', domain_id: 'd1', refresh_token: 'rt',
      credentials: { access_key_id: 'ak', secret_access_key: 'sk', security_token: 'st', expiration: '2026-08-04T00:00:00Z' },
    }));
  });
  const token = await exchangeCode({ cfg: { ...CFG, stsHost: stub.origin }, code: 'code-1', codeVerifier: 'verifier-1', port: 9999, dpopJwk: jwk });
  assert.equal(token.user_id, 'u1');
  assert.equal(token.credentials.security_token, 'st');
  const proof = verifyDpopProof(stub.requests[0].headers.dpop);
  assert.equal(proof.ok, true);
  assert.equal(proof.payload.htu, `${stub.origin}${EP_OAUTH_TOKENS}`);
});

test('refreshToken：grant_type=refresh_token + 原 code_verifier；DPoP 复用同密钥对', async (t) => {
  const proofs = [];
  const stub = await startStub(t, (req, res) => {
    proofs.push(req.headers.dpop);
    const form = new URLSearchParams(stub.requests[stub.requests.length - 1].body);
    assert.equal(form.get('grant_type'), 'refresh_token');
    assert.equal(form.get('refresh_token'), 'rt-1');
    assert.equal(form.get('code_verifier'), 'verifier-1');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      user_id: 'u1', refresh_token: 'rt-2',
      credentials: { access_key_id: 'ak2', secret_access_key: 'sk2', security_token: 'st2', expiration: '2026-09-03T00:00:00Z' },
    }));
  });
  const jwk = newDpopPrivateJwk();
  const token = await refreshToken({ cfg: { ...CFG, stsHost: stub.origin }, refreshToken: 'rt-1', codeVerifier: 'verifier-1', dpopJwk: jwk });
  assert.equal(token.credentials.access_key_id, 'ak2');
  const proof = verifyDpopProof(proofs[0]);
  assert.equal(proof.header.jwk.x, jwk.x, 'DPoP 公钥来自持久化 JWK');
});

test('legacy credential 归一（client.go:331-343）：credential{access,secret,securitytoken}', async (t) => {
  const stub = await startStub(t, (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ user_id: 'u9', credential: { access: 'AK', secret: 'SK', securitytoken: 'ST', expires_at: '2026-08-04T00:00:00Z' } }));
  });
  const tok = await pollTicket({ cfg: { ...CFG, snapManager: stub.origin }, ticketId: 'tk', secret: 'sec' });
  assert.equal(tok.credentials.access_key_id, 'AK');
  assert.equal(tok.credentials.security_token, 'ST');
  assert.equal(tok.credentials.expiration, '2026-08-04T00:00:00Z');
});

test('pollTicket：未登录（无凭证字段）→ null；plugin-name/version 头断言', async (t) => {
  const stub = await startStub(t, (req, res) => {
    assert.equal(req.headers['plugin-name'], 'snap_AIIDE');
    assert.equal(req.headers['plugin-version'], '5.2.0');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  });
  const out = await pollTicket({ cfg: { ...CFG, snapManager: stub.origin }, ticketId: 'tk', secret: 'sec' });
  assert.equal(out, null);
});

test('isRefreshTokenExpired：invalid_grant / ExpiredRefreshToken / InvalidDPoPHeader / invalid client id / has been used；5xx 普通 JSON 不算', () => {
  assert.equal(isRefreshTokenExpired(400, '{"error":"invalid_grant"}'), true);
  assert.equal(isRefreshTokenExpired(400, '{"error_code":"IAM.ExpiredRefreshToken"}'), true);
  assert.equal(isRefreshTokenExpired(400, '{"error_code":"STS.InvalidDPoPHeader"}'), true);
  assert.equal(isRefreshTokenExpired(400, '{"error_code":"invalid client id: bad"}'), true);
  assert.equal(isRefreshTokenExpired(400, '{"error_msg":"token has been used"}'), true);
  assert.equal(isRefreshTokenExpired(500, '{"error":"server"}'), false);
  assert.equal(isRefreshTokenExpired(400, 'not json'), false);
});

test('token manager：终态失效 → {expired:true}（needs_login），与 5xx 可重试分开', async (t) => {
  const expiredStub = await startStub(t, (req, res) => {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end('{"error":"invalid_grant","error_code":"IAM.ExpiredRefreshToken"}');
  });
  const tokens = createTokenManager({ cfg: { ...CFG, stsHost: expiredStub.origin }, now });
  const out = await tokens.accessFor({ id: 'a', refreshToken: 'rt', codeVerifier: 'v', dpopJwk: newDpopPrivateJwk() });
  assert.equal(out.expired, true, '终态失效');
  assert.equal(out.cred, null);
  assert.equal(out.patch, null);

  const serverStub = await startStub(t, (req, res) => {
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end('{"error":"bad gateway"}');
  });
  const retry = createTokenManager({ cfg: { ...CFG, stsHost: serverStub.origin }, now });
  const out2 = await retry.accessFor({ id: 'b', refreshToken: 'rt', codeVerifier: 'v', dpopJwk: newDpopPrivateJwk() });
  assert.equal(out2.expired, false, '5xx 不是终态');
  assert.equal(out2.cred, null);
  assert.equal(serverStub.requests.length, 2, '失败重试一次');
});

test('token manager：新鲜凭证不刷新；整组 patch 回传；单飞并发 1 次刷新', async (t) => {
  let hits = 0;
  const stub = await startStub(t, async (req, res) => {
    hits++;
    await new Promise((r) => setTimeout(r, 20));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      user_id: 'u1', refresh_token: 'rt-2',
      credentials: { access_key_id: `ak${hits}`, secret_access_key: 'sk', security_token: 'st', expiration: '2026-09-03T00:00:00Z' },
    }));
  });
  const tokens = createTokenManager({ cfg: { ...CFG, stsHost: stub.origin }, now });
  assert.equal(EXPIRY_BUFFER_MS, 5 * 60_000);

  const fresh = { id: 'a', accessKeyID: 'ak', secretAccessKey: 'sk', securityToken: 'st', expiresAt: NOW + 3_600_000, refreshToken: 'rt' };
  const ok = await tokens.accessFor(fresh);
  assert.equal(ok.cred.securityToken, 'st');
  assert.equal(ok.patch, null);
  assert.equal(hits, 0, '新鲜凭证不打上游');

  const stale = { id: 'b', accessKeyID: 'old', secretAccessKey: 's', securityToken: 't', expiresAt: NOW, refreshToken: 'rt-1', codeVerifier: 'v', dpopJwk: newDpopPrivateJwk() };
  const results = await Promise.all(Array.from({ length: 8 }, () => tokens.accessFor(stale)));
  assert.equal(hits, 1, '并发 8 次只 1 次刷新');
  assert.ok(results.every((r) => r.patch?.securityToken === 'st'), '整组 patch');
  assert.equal(results[0].patch.refreshToken, 'rt-2', '轮换的 refresh_token 进 patch');
});

test('expiresAtMsOf：RFC3339 → 毫秒；缺失按 1h 兜底', () => {
  assert.equal(expiresAtMsOf('2026-08-04T00:00:00Z'), Date.parse('2026-08-04T00:00:00Z'));
  assert.equal(expiresAtMsOf('', NOW), NOW + 3_600_000);
  assert.equal(expiresAtMsOf('garbage', NOW), NOW + 3_600_000);
});

test('accountFromToken：id=ca-<user_id>，凭证整组 + verifier + dpopJwk 落入账号', () => {
  const jwk = newDpopPrivateJwk();
  const acc = accountFromToken(
    {
      user_id: 'u1', user_name: 'n1', domain_id: 'd1', refresh_token: 'rt',
      credentials: { access_key_id: 'ak', secret_access_key: 'sk', security_token: 'st', expiration: '2026-08-04T00:00:00Z' },
    },
    { codeVerifier: 'v', dpopJwk: jwk },
  );
  assert.equal(acc.id, 'ca-u1');
  assert.equal(acc.label, 'n1');
  assert.equal(acc.securityToken, 'st');
  assert.equal(acc.refreshToken, 'rt');
  assert.equal(acc.codeVerifier, 'v');
  assert.deepEqual(acc.dpopJwk, jwk);
  assert.equal(acc.state, 'ok');
});
