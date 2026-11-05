// M5 评审修复回归：refreshToken 轮换落盘（F1）、流内错误惩罚 + error 事件（F2）、
// 死道模型剔除（F3）、孤儿 tool_result 剔除（F4）、UGW_TRAE_API_HOST 进 boot（F5）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startStub } from './helpers/stub.mjs';
import { startGateway, seedDb } from './helpers/gateway.mjs';
import { createTraePool } from '../pools/trae/index.mjs';
import { buildTraePayload } from '../pools/trae/payload.mjs';
import { EP_EXCHANGE } from '../pools/trae/constants.mjs';

const CHAT_PATH = '/api/agent/v3/llm_utils_chat';
const AUTH_PATH = '/cloudide/api/v3/trae/oauth/ExchangeToken';

function soloSse(parts) {
  return parts.map((p) => `event: ${p.event}\ndata: ${JSON.stringify(p.data)}\n\n`).join('');
}

const OK_SSE = soloSse([
  { event: 'output', data: { response: 'ok' } },
  { event: 'done', data: { finish_reason: 'stop' } },
]);

const ACCOUNT = () => ({
  id: 'trae-01',
  uid: '37396015402',
  jwt: 'jwt-1',
  refreshToken: 'rt-1',
  expiresAt: Date.now() + 3_600_000,
  machineId: 'm'.repeat(32),
  deviceId: 'd'.repeat(32),
  state: 'ok',
  weight: 10,
  enabled: true,
});

function makePool(stub, overrides = {}) {
  return createTraePool({
    accounts: overrides.accounts ?? [ACCOUNT()],
    config: {
      endpoints: {
        chat: `${stub.origin}${CHAT_PATH}`,
        auth: `${stub.origin}${AUTH_PATH}`,
        quota: `${stub.origin}/trae/api/v2/pay/ide_user_ent_usage`,
        checkin: `${stub.origin}/trae/api/v2/ug/checkin_credits/status`,
      },
      maxAttempts: overrides.maxAttempts ?? 1,
      ...(overrides.config ?? {}),
    },
  });
}

test('F1：refreshToken 轮换立即落盘到 accounts.json（tmp+rename）', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ugw-trae-f1-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const accountsFile = path.join(dir, 'accounts.json');
  const expired = { ...ACCOUNT(), jwt: 'old-jwt', refreshToken: 'rt-old', expiresAt: Date.now() - 1_000 };
  fs.writeFileSync(accountsFile, JSON.stringify([expired], null, 2));

  const stub = await startStub(t, (req, res) => {
    if (req.url === AUTH_PATH) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          Result: { Token: 'new-jwt', RefreshToken: 'rt-new', TokenExpireAt: Math.floor((Date.now() + 86_400_000) / 1000) },
        }),
      );
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(OK_SSE);
  });
  const pool = makePool(stub, { accounts: [expired], config: { accountsFile } });
  const out = await pool.sendCollect({
    req: { headers: {} },
    body: { model: 'glm-5.2', max_tokens: 64, messages: [{ role: 'user', content: 'hi' }] },
    key: { id: 'k1' },
    signal: undefined,
  });
  assert.equal(out.status, 200);

  // 磁盘上的账号文件已合并 patch（旧 rt 即作废，重启不能丢）
  const onDisk = JSON.parse(fs.readFileSync(accountsFile, 'utf8'));
  assert.equal(onDisk.length, 1);
  assert.equal(onDisk[0].refreshToken, 'rt-new');
  assert.equal(onDisk[0].jwt, 'new-jwt');
  assert.ok(onDisk[0].expiresAt > Date.now(), 'expiresAt 应更新为未来时间');
  // 运行态同样已更新
  const acc = pool.scheduler.accounts.find((a) => a.id === 'trae-01');
  assert.equal(acc.jwt, 'new-jwt');
  assert.equal(acc.refreshToken, 'rt-new');
});

test('F5：未给 endpoints.auth 时 apiHost 兜底拼 ExchangeToken 地址', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ugw-trae-f5-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const expired = { ...ACCOUNT(), jwt: 'old-jwt', refreshToken: 'rt-old', expiresAt: Date.now() - 1_000 };
  const stub = await startStub(t, (req, res) => {
    if (req.url === AUTH_PATH) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ Result: { Token: 'new-jwt', RefreshToken: 'rt-old', TokenExpireAt: Math.floor((Date.now() + 86_400_000) / 1000) } }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(OK_SSE);
  });
  const pool = createTraePool({
    accounts: [expired],
    config: {
      apiHost: stub.origin,
      chatUrl: `${stub.origin}${CHAT_PATH}`,
      endpoints: { chat: `${stub.origin}${CHAT_PATH}` },
      maxAttempts: 1,
      accountsFile: path.join(dir, 'accounts.json'),
    },
  });
  await pool.sendCollect({
    req: { headers: {} },
    body: { model: 'glm-5.2', max_tokens: 64, messages: [{ role: 'user', content: 'hi' }] },
    key: { id: 'k1' },
    signal: undefined,
  });
  const auth = stub.requests.find((r) => r.url === AUTH_PATH);
  assert.ok(auth, 'apiHost + EP_EXCHANGE 应作为刷新地址');
});

test('F2：流式 1005 → 账号 12h 冷却 + 客户端收到 Anthropic error 事件（不裸 destroy）', async (t) => {
  const t0 = Date.now();
  const stub = await startStub(t, (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(soloSse([{ event: 'error', data: { code: 1005, message: 'exceed quota limit' } }]));
  });
  const pool = makePool(stub, { maxAttempts: 1 });
  const { db, full } = seedDb({ name: 'dev', pools: ['trae'] });
  const { base } = await startGateway(t, { pools: [pool], db });

  const res = await fetch(`${base}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': full },
    body: JSON.stringify({ model: 'trae/glm-5.2', max_tokens: 64, stream: true, messages: [{ role: 'user', content: 'hi' }] }),
  });
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.match(text, /^event: error$/m, '应以 error 事件收尾');
  const errData = JSON.parse(text.match(/^data: (.+)$/m)[1]);
  assert.equal(errData.type, 'error');
  assert.equal(errData.error.type, 'rate_limit_error');
  assert.match(errData.error.message, /1005/);

  const acc = pool.scheduler.accounts[0];
  assert.ok(acc.cooldownUntil >= t0 + 12 * 3_600_000, '流内错误也应触发 12h 冷却');
  assert.equal(acc.cooldownKind, 'quota_exhausted');
});

test('F2：流式 4001 → 客户端 error 事件，账号不冷却', async (t) => {
  const stub = await startStub(t, (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(soloSse([{ event: 'error', data: { code: 4001, message: "We're sorry, the param is invalid." } }]));
  });
  const pool = makePool(stub, { maxAttempts: 1 });
  const { db, full } = seedDb({ name: 'dev', pools: ['trae'] });
  const { base } = await startGateway(t, { pools: [pool], db });

  const res = await fetch(`${base}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': full },
    body: JSON.stringify({ model: 'trae/glm-5.2', max_tokens: 64, stream: true, messages: [{ role: 'user', content: 'hi' }] }),
  });
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.match(text, /^event: error$/m);
  const acc = pool.scheduler.accounts[0];
  assert.equal(acc.cooldownUntil, 0, '请求级失败不冷却账号');
  assert.equal(acc.state, 'ok');
});

test('F3：models.json 不再包含非 Official 的 DeepSeek-V4 死道模型', () => {
  const file = new URL('../pools/trae/models.json', import.meta.url);
  const ids = JSON.parse(fs.readFileSync(file, 'utf8')).map((m) => m.id);
  assert.ok(!ids.includes('DeepSeek-V4-Flash'));
  assert.ok(!ids.includes('DeepSeek-V4-Pro'));
  assert.ok(ids.includes('DeepSeek-V4-Flash-Official'), 'Official 条目保留');
});

test('F4：孤儿 tool_result（tool_use_id 无前文匹配）剔除，顺序与其余不变', () => {
  const body = {
    model: 'glm-5.2',
    max_tokens: 64,
    messages: [
      { role: 'user', content: '查天气' },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: { city: '北京' } }],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_ghost', content: '悬空' },
          { type: 'tool_result', tool_use_id: 'toolu_1', content: '晴 25 度' },
          { type: 'text', text: '继续' },
        ],
      },
    ],
  };
  const out = buildTraePayload(body, 'glm-5.2');
  const toolMsgs = out.messages.filter((m) => m.role === 'tool');
  assert.equal(toolMsgs.length, 1, '孤儿剔除后只剩配对的 tool 消息');
  assert.equal(toolMsgs[0].tool_call_id, 'toolu_1');
  assert.deepEqual(
    out.messages.map((m) => m.role),
    ['user', 'assistant', 'tool', 'user'],
    '非 tool 消息顺序不变',
  );
});
