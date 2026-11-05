import test from 'node:test';
import assert from 'node:assert/strict';
import { startStub } from './helpers/stub.mjs';
import { startGateway, seedDb } from './helpers/gateway.mjs';
import { createTraePool, classifyUpstreamError, anthropicMessageFromEvents } from '../pools/trae/index.mjs';

const CHAT_PATH = '/api/agent/v3/llm_utils_chat';
const ENT_PATH = '/trae/api/v2/pay/ide_user_ent_usage';

function soloSse(parts) {
  return parts.map((p) => `event: ${p.event}\ndata: ${JSON.stringify(p.data)}\n\n`).join('');
}

const OK_SSE = soloSse([
  { event: 'metadata', data: { agent: 'solo' } },
  { event: 'output', data: { response: 'Hello' } },
  { event: 'output', data: { response: ' world' } },
  { event: 'token_usage', data: { prompt_tokens: 12, completion_tokens: 3 } },
  { event: 'done', data: { finish_reason: 'stop' } },
]);

const ACCOUNT = () => ({
  id: 'trae-01',
  label: 'a1',
  uid: '37396015402',
  nickname: 'zephyr',
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
        auth: `${stub.origin}/cloudide/api/v3/trae/oauth/ExchangeToken`,
        quota: `${stub.origin}${ENT_PATH}`,
        checkin: `${stub.origin}/trae/api/v2/ug/checkin_credits/status`,
      },
      maxAttempts: overrides.maxAttempts ?? 2,
      ...(overrides.config ?? {}),
    },
  });
}

test('端到端非流式 /v1/messages：上游收到 SOLO 头 + 白名单体，客户端拿到 Anthropic JSON', async (t) => {
  const stub = await startStub(t, (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(OK_SSE);
  });
  const pool = makePool(stub);
  const { db, full } = seedDb({ name: 'dev', pools: ['trae'] });
  const { base } = await startGateway(t, { pools: [pool], db });

  const res = await fetch(`${base}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': full },
    body: JSON.stringify({ model: 'trae/glm-5.2', max_tokens: 64, messages: [{ role: 'user', content: 'hi' }] }),
  });
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.equal(body.type, 'message');
  assert.deepEqual(body.content, [{ type: 'text', text: 'Hello world' }]);
  assert.equal(body.stop_reason, 'end_turn');
  assert.deepEqual(body.usage, { input_tokens: 12, output_tokens: 3 });

  const rec = stub.requests.find((r) => r.url === CHAT_PATH);
  assert.ok(rec, 'chat 请求应打到桩');
  assert.equal(rec.headers['authorization'], 'Cloud-IDE-JWT jwt-1');
  assert.equal(rec.headers['x-cloudide-token'], 'jwt-1');
  assert.equal(rec.headers['x-uid'], '37396015402');
  assert.equal(rec.headers['x-machine-id'], 'm'.repeat(32));
  assert.equal(rec.headers['user-agent'], 'Trae/0.1.61');

  const payload = JSON.parse(rec.body);
  assert.equal(payload.function, 'solo_work_lite');
  assert.equal(payload.stream, true);
  assert.equal(payload.config_name, 'glm-5.2');
  assert.deepEqual(payload.messages, [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]);
});

test('端到端流式：客户端逐事件收到 Anthropic SSE', async (t) => {
  const stub = await startStub(t, (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(OK_SSE);
  });
  const pool = makePool(stub);
  const { db, full } = seedDb({ name: 'dev', pools: ['trae'] });
  const { base } = await startGateway(t, { pools: [pool], db });

  const res = await fetch(`${base}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': full },
    body: JSON.stringify({ model: 'trae/glm-5.2', max_tokens: 64, stream: true, messages: [{ role: 'user', content: 'hi' }] }),
  });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/event-stream/);
  const text = await res.text();
  const types = [...text.matchAll(/^event: (\S+)$/gm)].map((m) => m[1]);
  assert.deepEqual(types, [
    'message_start',
    'content_block_start',
    'content_block_delta',
    'content_block_delta',
    'content_block_stop',
    'message_delta',
    'message_stop',
  ]);
});

test('HTTP 401 → needs_login，不重试同账号', async (t) => {
  let chatHits = 0;
  const stub = await startStub(t, (req, res) => {
    if (req.url !== CHAT_PATH) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
      return;
    }
    chatHits++;
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ code: 1001, message: 'jwt invalid' }));
  });
  const pool = makePool(stub);
  const { db, full } = seedDb({ name: 'dev', pools: ['trae'] });
  const { base } = await startGateway(t, { pools: [pool], db });

  const res = await fetch(`${base}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': full },
    body: JSON.stringify({ model: 'trae/glm-5.2', max_tokens: 64, messages: [{ role: 'user', content: 'hi' }] }),
  });
  assert.equal(res.status, 401); // auth 失败原样 4xx + authentication_error（同 qoder errorFrom 形状）
  assert.equal(pool.scheduler.accounts.find((a) => a.id === 'trae-01').state, 'needs_login');
  assert.equal(chatHits, 1, 'auth 失败不换号重试（单账号池无候选）');
});

test('流内 1005 → 换号重试 + 账号 12h 冷却（cooldownUntil 精确断言）', async (t) => {
  const t0 = Date.now();
  let chatHits = 0;
  const stub = await startStub(t, (req, res) => {
    if (req.url !== CHAT_PATH) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
      return;
    }
    chatHits++;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(
      soloSse([
        { event: 'error', data: { code: 1005, message: 'exceed quota limit' } },
      ]),
    );
  });
  const accounts = [ACCOUNT(), { ...ACCOUNT(), id: 'trae-02', jwt: 'jwt-2', uid: 'u2' }];
  const pool = makePool(stub, { accounts });
  const { db, full } = seedDb({ name: 'dev', pools: ['trae'] });
  const { base } = await startGateway(t, { pools: [pool], db });

  const res = await fetch(`${base}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': full },
    body: JSON.stringify({ model: 'trae/glm-5.2', max_tokens: 64, messages: [{ role: 'user', content: 'hi' }] }),
  });
  assert.equal(res.status, 429);
  assert.equal(chatHits, 2, '两个账号各试一次（换号重试）');
  for (const acc of pool.scheduler.accounts) {
    assert.ok(acc.cooldownUntil >= t0 + 12 * 3_600_000, `${acc.id} 应 12h 冷却`);
    assert.equal(acc.cooldownKind, 'quota_exhausted');
    assert.ok(acc.cooldownUntil <= Date.now() + 12 * 3_600_000 + 60_000);
  }
});

test('流内 4001 → 客户端 400，账号不冷却不换号', async (t) => {
  const stub = await startStub(t, (req, res) => {
    if (req.url !== CHAT_PATH) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
      return;
    }
    chatHits++;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(soloSse([{ event: 'error', data: { code: 4001, message: "We're sorry, the param is invalid." } }]));
  });
  let chatHits = 0;
  const accounts = [ACCOUNT(), { ...ACCOUNT(), id: 'trae-02', jwt: 'jwt-2', uid: 'u2' }];
  const pool = makePool(stub, { accounts });
  const { db, full } = seedDb({ name: 'dev', pools: ['trae'] });
  const { base } = await startGateway(t, { pools: [pool], db });

  const res = await fetch(`${base}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': full },
    body: JSON.stringify({ model: 'trae/glm-5.2', max_tokens: 64, messages: [{ role: 'user', content: 'hi' }] }),
  });
  const body = await res.json();
  assert.equal(res.status, 400);
  assert.match(body.error.message, /4001/);
  assert.equal(chatHits, 1, '请求级失败不换号');
  for (const acc of pool.scheduler.accounts) {
    assert.equal(acc.cooldownUntil, 0, '账号不冷却');
    assert.equal(acc.state, 'ok');
  }
});

test('quota：dispatch 后 fire-and-forget 拉取，peek 非 null，checkin 进账号快照', async (t) => {
  const stub = await startStub(t, (req, res) => {
    if (req.url.startsWith('/trae/api/v2/pay/')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          user_entitlement_pack_list: [
            { entitlement_base_info: { quota: { credits_limit: 30 } }, usage: { credits_amount: 10 } },
            { entitlement_base_info: { quota: { credits_limit: 20 } }, usage: { credits_amount: 5 } },
          ],
        }),
      );
      return;
    }
    if (req.url.startsWith('/trae/api/v2/ug/checkin_credits/status')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ checked_in: false, credits: 50, enable: true }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(OK_SSE);
  });
  const pool = makePool(stub);
  const { db, full } = seedDb({ name: 'dev', pools: ['trae'] });
  const { base } = await startGateway(t, { pools: [pool], db });

  const res = await fetch(`${base}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': full },
    body: JSON.stringify({ model: 'trae/glm-5.2', max_tokens: 64, messages: [{ role: 'user', content: 'hi' }] }),
  });
  assert.equal(res.status, 200);

  // fire-and-forget：等微任务 + 桩响应落定
  await new Promise((r) => setTimeout(r, 100));
  const acc = pool.scheduler.accounts[0];
  assert.equal(pool.quota.peek(acc), 0.7, 'credits_limit 30+20、已用 10+5 → 剩余 35/50');
  assert.deepEqual(acc.checkin, { checked_in: false, credits: 50, enable: true });

  const usageRec = stub.requests.find((r) => r.url === ENT_PATH);
  assert.ok(usageRec, 'ent_usage 应打到桩');
  assert.equal(usageRec.headers['user-agent'], 'VSCode 1.107.1 (TRAE SOLO CN)');
  assert.notEqual(usageRec.headers['user-agent'], 'Trae/0.1.61');
});

test('/v1/models 出现 trae/ 前缀模型', async (t) => {
  const stub = await startStub(t, () => {});
  const pool = makePool(stub);
  const { db, full } = seedDb({ name: 'dev', pools: ['trae'] });
  const { base } = await startGateway(t, { pools: [pool], db });

  const res = await fetch(`${base}/v1/models`, { headers: { 'x-api-key': full } });
  const body = await res.json();
  const ids = body.data.map((m) => m.id);
  assert.ok(ids.includes('trae/glm-5.2'));
  assert.ok(ids.includes('trae/kimi-k3'));
  const glm = body.data.find((m) => m.id === 'trae/glm-5.2');
  assert.equal(glm.context_window, 1_000_000);
});

test('sendCollect 契约：返回 {status, contentType, bodyText} 聚合 JSON，不写 res', async (t) => {
  const stub = await startStub(t, (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(OK_SSE);
  });
  const pool = makePool(stub);
  const out = await pool.sendCollect({
    req: { headers: {} },
    body: { model: 'glm-5.2', max_tokens: 64, messages: [{ role: 'user', content: 'hi' }] },
    key: { id: 'k1' },
    signal: undefined,
  });
  assert.equal(out.status, 200);
  assert.equal(out.contentType, 'application/json');
  const msg = JSON.parse(out.bodyText);
  assert.deepEqual(msg.content, [{ type: 'text', text: 'Hello world' }]);
  assert.deepEqual(msg.usage, { input_tokens: 12, output_tokens: 3 });
});

test('未知模型 → 400 invalid_request_error', async (t) => {
  const stub = await startStub(t, () => {});
  const pool = makePool(stub);
  await assert.rejects(
    pool.sendCollect({ req: { headers: {} }, body: { model: 'nope', messages: [] }, key: { id: 'k' } }),
    (err) => err.status === 400 && err.type === 'invalid_request_error',
  );
});

test('classifyUpstreamError：HTTP 200 业务信封外层（流外 body code）分类', () => {
  assert.deepEqual(classifyUpstreamError(429, '{"code":1005,"msg":"exceed quota limit"}').kind, 'quota_exhausted');
  assert.deepEqual(classifyUpstreamError(400, '{"code":4001}').retryable, false);
  assert.deepEqual(classifyUpstreamError(500, 'oops').kind, 'server');
  assert.deepEqual(classifyUpstreamError(403, '').kind, 'auth');
});

test('anthropicMessageFromEvents：tool_use / thinking 聚合', () => {
  const events = [
    { type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', model: 'glm-5.2', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 't1', name: 'get_weather', input: {} } },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"city":' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '"北京"}' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { input_tokens: 5, output_tokens: 7 } },
    { type: 'message_stop' },
  ];
  const msg = anthropicMessageFromEvents(events);
  assert.deepEqual(msg.content, [{ type: 'tool_use', id: 't1', name: 'get_weather', input: { city: '北京' } }]);
  assert.equal(msg.stop_reason, 'tool_use');
});
