import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startStub } from './helpers/stub.mjs';
import { tmpDataDir, makePool, startPanel, login, panelFetch } from './helpers/panel.mjs';
import { createWorkbuddyPool } from '../pools/workbuddy/index.mjs';

test('面板 onboard 两段式：link 拿登录链接 + state 落 flow；poll 未就绪 pending；就绪后落账号', async (t) => {
  let authStateReady = false;
  const stub = await startStub(t, (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    if (req.url.startsWith('/v2/plugin/auth/state')) {
      res.end(JSON.stringify({ data: { data: { authUrl: 'https://login.example/wb?state=st-9', state: 'st-9' } } }));
      return;
    }
    if (req.url.startsWith('/v2/plugin/auth/token')) {
      if (!authStateReady) return void res.end(JSON.stringify({ data: { data: {} } }));
      res.end(JSON.stringify({ data: { data: { accessToken: 'at-onboard', refreshToken: 'rt-onboard', domain: 'd.cn' } } }));
      return;
    }
    if (req.url.startsWith('/v2/plugin/login/account')) {
      res.end(JSON.stringify({ data: { data: { uid: 4242, nickname: 'zephyr' } } }));
      return;
    }
    res.end('{}');
  });

  const dataDir = tmpDataDir(t, 'ugw-wb-panel-');
  const wbDir = path.join(dataDir, 'pools', 'workbuddy-cn');
  fs.mkdirSync(wbDir, { recursive: true });
  const wbPool = createWorkbuddyPool({
    accounts: [],
    region: 'cn',
    config: { dataDir, endpoint: stub.origin, endpoints: { chat: `${stub.origin}/v2/chat/completions`, auth: stub.origin, biz: stub.origin, models: stub.origin } },
  });
  const { base } = await startPanel(t, { pools: [wbPool], dataDir, panelOptions: { wbEndpointCn: stub.origin, wbEndpointGlobal: stub.origin } });
  const { cookies } = await login(base);

  // 第一段：link
  const link = await panelFetch(base, '/api/onboard/workbuddy', {
    method: 'POST',
    cookies,
    body: { region: 'cn', action: 'link' },
  });
  assert.equal(link.status, 200);
  const linkBody = link.json();
  assert.equal(linkBody.loginUrl, 'https://login.example/wb?state=st-9');
  assert.ok(linkBody.flowId, 'flowId 返回');

  // flow 落盘（onboard-flows.json 复用）
  const flowsFile = path.join(dataDir, 'onboard-flows.json');
  const flows = JSON.parse(fs.readFileSync(flowsFile, 'utf8')).flows;
  assert.equal(flows[linkBody.flowId].state, 'st-9');

  // 第二段：poll 未就绪
  const pending = await panelFetch(base, '/api/onboard/workbuddy', {
    method: 'POST',
    cookies,
    body: { region: 'cn', action: 'poll', flowId: linkBody.flowId },
  });
  assert.equal(pending.status, 200);
  assert.equal(pending.json().pending, true, '未登录 → pending，不报错');

  // 用户在浏览器完成登录 → poll 就绪 → 落账号
  authStateReady = true;
  const done = await panelFetch(base, '/api/onboard/workbuddy', {
    method: 'POST',
    cookies,
    body: { region: 'cn', action: 'poll', flowId: linkBody.flowId },
  });
  assert.equal(done.status, 200);
  const { account } = done.json();
  assert.equal(account.id, 'wb-4242');
  assert.equal(account.nickname, 'zephyr');

  // 账号落盘 + 进运行态
  const persisted = JSON.parse(fs.readFileSync(path.join(wbDir, 'accounts.json'), 'utf8'));
  assert.equal(persisted.length, 1);
  assert.equal(persisted[0].jwt, 'at-onboard');
  assert.equal(persisted[0].refreshToken, 'rt-onboard');
  assert.equal(wbPool.accounts.some((a) => a.id === 'wb-4242'), true, '运行态 upsert');

  // flow 一次性
  const flowsAfter = JSON.parse(fs.readFileSync(flowsFile, 'utf8')).flows;
  assert.equal(flowsAfter[linkBody.flowId], undefined);
});

test('onboard 参数校验：region 非法 400、action 非法 400、flowId 未知 404', async (t) => {
  const stub = await startStub(t, (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: { data: { authUrl: 'u', state: 's' } } }));
  });
  const dataDir = tmpDataDir(t, 'ugw-wb-panel2-');
  const wbPool = createWorkbuddyPool({ accounts: [], region: 'cn', config: { dataDir, endpoint: stub.origin, endpoints: { chat: stub.origin, auth: stub.origin, biz: stub.origin, models: stub.origin } } });
  const { base } = await startPanel(t, { pools: [wbPool], dataDir, panelOptions: { wbEndpointCn: stub.origin, wbEndpointGlobal: stub.origin } });
  const { cookies } = await login(base);

  const badRegion = await panelFetch(base, '/api/onboard/workbuddy', { method: 'POST', cookies, body: { region: 'jp', action: 'link' } });
  assert.equal(badRegion.status, 400);
  const badAction = await panelFetch(base, '/api/onboard/workbuddy', { method: 'POST', cookies, body: { region: 'cn', action: 'nope' } });
  assert.equal(badAction.status, 400);
  const badFlow = await panelFetch(base, '/api/onboard/workbuddy', { method: 'POST', cookies, body: { region: 'cn', action: 'poll', flowId: 'nope' } });
  assert.equal(badFlow.status, 404);
});
