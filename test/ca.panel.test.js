// ca.panel.test.js — CodeArts onboard 两段式端到端（桩）：link → callback 粘贴 / poll 轮询。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startStub } from './helpers/stub.mjs';
import { tmpDataDir, startPanel, login, panelFetch } from './helpers/panel.mjs';
import { createCodeartsPool } from '../pools/codearts/index.mjs';
import { LOGIN_CONFIG_DEFAULTS } from '../pools/codearts/auth.mjs';

// 桩上的 token 端点路径（panel LOGIN_CONFIG 用生产 STS host，所以桩要按完整 URL 分流）
const STS_PATH = '/v1/oauth2/tokens';
const TICKET_PATH = '/v1/login/ticket';

function tokenResponse() {
  return {
    user_id: 'u4242', user_name: 'zephyr', domain_id: 'd1', refresh_token: 'rt-onboard',
    credentials: { access_key_id: 'AK', secret_access_key: 'SK', security_token: 'ST', expiration: '2099-01-01T00:00:00Z' },
  };
}

async function setup(t, handler) {
  const stub = await startStub(t, handler);
  const dataDir = tmpDataDir(t, 'ugw-ca-panel-');
  const caDir = path.join(dataDir, 'pools', 'codearts');
  fs.mkdirSync(caDir, { recursive: true });
  const caPool = createCodeartsPool({
    accounts: [],
    config: {
      dataDir,
      snapBase: stub.origin,
      benefitBase: stub.origin,
      endpoints: { chat: `${stub.origin}/api/v2/chat/completions`, models: stub.origin, benefit: stub.origin, biz: stub.origin },
    },
  });
  const { base } = await startPanel(t, { pools: [caPool], dataDir, panelOptions: { caLoginConfig: { ...LOGIN_CONFIG_DEFAULTS, stsHost: stub.origin, snapManager: stub.origin, portalHost: stub.origin } } });
  const { cookies } = await login(base);
  return { stub, dataDir, caPool, base, cookies };
}

test('面板 onboard：link 生成授权链接 + flow 落盘；callback 粘贴回跳 → 换 token → 落账号', async (t) => {
  const { stub, dataDir, caPool, base, cookies } = await setup(t, (req, res) => {
    if (req.url === STS_PATH) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(tokenResponse()));
      return;
    }
    res.end('{}');
  });

  // 第一段：link
  const link = await panelFetch(base, '/api/onboard/codearts', { method: 'POST', cookies, body: { action: 'link' } });
  assert.equal(link.status, 200);
  const linkBody = link.json();
  assert.match(linkBody.authorizeUrl, /^http:\/\/127\.0\.0\.1:\d+\/authorize\?/);
  assert.match(linkBody.authorizeUrl, /client_id=codearts-agent/);
  assert.ok(linkBody.flowId);

  // flow 落盘（含 PKCE verifier 与 DPoP 私钥——refresh_token 双绑定所需）
  const flowsFile = path.join(dataDir, 'onboard-flows.json');
  const flow = JSON.parse(fs.readFileSync(flowsFile, 'utf8')).flows[linkBody.flowId];
  assert.ok(flow.codeVerifier);
  assert.equal(flow.dpopJwk.crv, 'P-256');
  assert.ok(flow.dpopJwk.d);

  // 第二段：callback 粘贴（portal 回跳 127.0.0.1:1455 失败，用户复制地址栏 URL）
  const pasted = `http://127.0.0.1:1455/oauth/callback?code=the-code&ticket_id=${flow.ticketId}`;
  const done = await panelFetch(base, '/api/onboard/codearts', {
    method: 'POST',
    cookies,
    body: { action: 'callback', flowId: linkBody.flowId, callbackUrl: pasted },
  });
  assert.equal(done.status, 200);
  const { account } = done.json();
  assert.equal(account.id, 'ca-u4242');
  assert.equal(account.label, 'zephyr');

  // 换 token 请求：PKCE verifier / redirect_uri / DPoP 断言
  const rec = stub.requests.find((r) => r.url === STS_PATH);
  assert.ok(rec, '换 token 请求打到 STS 桩');
  const form = new URLSearchParams(rec.body);
  assert.equal(form.get('grant_type'), 'authorization_code');
  assert.equal(form.get('code'), 'the-code');
  assert.equal(form.get('code_verifier'), flow.codeVerifier);
  assert.equal(form.get('redirect_uri'), 'http://127.0.0.1:1455/oauth/callback');
  assert.ok(rec.headers.dpop, '换 token 带 DPoP 证明');
  const proofHeader = JSON.parse(Buffer.from(rec.headers.dpop.split('.')[0], 'base64url').toString('utf8'));
  assert.equal(proofHeader.jwk.x, flow.dpopJwk.x, 'DPoP 用 flow 里持久化的同一密钥对');

  // 账号落盘（凭证整组 + verifier + dpopJwk）+ 进运行态
  const persisted = JSON.parse(fs.readFileSync(path.join(dataDir, 'pools', 'codearts', 'accounts.json'), 'utf8'));
  assert.equal(persisted.length, 1);
  assert.equal(persisted[0].securityToken, 'ST');
  assert.equal(persisted[0].refreshToken, 'rt-onboard');
  assert.equal(persisted[0].codeVerifier, flow.codeVerifier);
  assert.equal(caPool.accounts.some((a) => a.id === 'ca-u4242'), true, '运行态 upsert');

  // flow 一次性
  const flowsAfter = JSON.parse(fs.readFileSync(flowsFile, 'utf8')).flows;
  assert.equal(flowsAfter[linkBody.flowId], undefined);
});

test('面板 onboard：poll ticket 轮询——未登录 pending；就绪落账号', async (t) => {
  let ready = false;
  const { stub, dataDir, base, cookies } = await setup(t, (req, res) => {
    if (req.url.startsWith(TICKET_PATH)) {
      res.writeHead(200, { 'content-type': 'application/json' });
      if (!ready) return void res.end('{}');
      assert.equal(req.headers['plugin-name'], 'snap_AIIDE');
      res.end(JSON.stringify(tokenResponse()));
      return;
    }
    res.end('{}');
  });

  const link = await panelFetch(base, '/api/onboard/codearts', { method: 'POST', cookies, body: { action: 'link' } });
  const { flowId } = link.json();

  const pending = await panelFetch(base, '/api/onboard/codearts', { method: 'POST', cookies, body: { action: 'poll', flowId } });
  assert.equal(pending.status, 200);
  assert.equal(pending.json().pending, true, '未登录 → pending，不报错');

  ready = true;
  const done = await panelFetch(base, '/api/onboard/codearts', { method: 'POST', cookies, body: { action: 'poll', flowId } });
  assert.equal(done.status, 200);
  assert.equal(done.json().account.id, 'ca-u4242');
  assert.ok(stub.requests.some((r) => r.url.startsWith(TICKET_PATH)), 'ticket 轮询打到 snap-manager 桩');

  const persisted = JSON.parse(fs.readFileSync(path.join(dataDir, 'pools', 'codearts', 'accounts.json'), 'utf8'));
  assert.equal(persisted.length, 1);
});

test('onboard 参数校验：action 非法 400、flowId 未知 404、回调缺 code 400', async (t) => {
  const { base, cookies } = await setup(t, (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  });

  const badAction = await panelFetch(base, '/api/onboard/codearts', { method: 'POST', cookies, body: { action: 'nope' } });
  assert.equal(badAction.status, 400);
  const badFlow = await panelFetch(base, '/api/onboard/codearts', { method: 'POST', cookies, body: { action: 'poll', flowId: 'nope' } });
  assert.equal(badFlow.status, 404);

  const link = await panelFetch(base, '/api/onboard/codearts', { method: 'POST', cookies, body: { action: 'link' } });
  const { flowId } = link.json();
  const noCode = await panelFetch(base, '/api/onboard/codearts', {
    method: 'POST',
    cookies,
    body: { action: 'callback', flowId, callbackUrl: 'http://127.0.0.1:1455/oauth/callback?ticket_id=x' },
  });
  assert.equal(noCode.status, 400);
});
