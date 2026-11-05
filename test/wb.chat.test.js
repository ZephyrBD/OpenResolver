import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startStub } from './helpers/stub.mjs';
import { startGateway, seedDb } from './helpers/gateway.mjs';
import { createWorkbuddyPool } from '../pools/workbuddy/index.mjs';

const CHAT_PATH = '/v2/chat/completions';

function openAiSse(chunks) {
  return chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n';
}

const OK_SSE = openAiSse([
  { id: 'chatcmpl-1', object: 'chat.completion.chunk', model: 'glm-5.2', choices: [{ index: 0, delta: { role: 'assistant', content: 'Hello' }, finish_reason: null }] },
  { id: 'chatcmpl-1', object: 'chat.completion.chunk', model: 'glm-5.2', choices: [{ index: 0, delta: { content: ' world' }, finish_reason: null }] },
  { id: 'chatcmpl-1', object: 'chat.completion.chunk', model: 'glm-5.2', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 3 } },
]);

const ACCOUNT = () => ({
  id: 'wb-10001',
  label: 'wb1',
  uid: '10001',
  jwt: 'at-1',
  refreshToken: 'rt-1',
  expiresAt: Date.now() + 3_600_000,
  domain: 'd.example',
  state: 'ok',
  weight: 10,
  enabled: true,
});

function makePool(stub, overrides = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ugw-wb-chat-'));
  return createWorkbuddyPool({
    accounts: overrides.accounts ?? [ACCOUNT()],
    region: overrides.region ?? 'cn',
    config: {
      dataDir,
      endpoint: stub.origin,
      endpoints: {
        chat: `${stub.origin}${CHAT_PATH}`,
        auth: stub.origin,
        biz: `${stub.origin}`,
        models: `${stub.origin}`,
      },
      maxAttempts: overrides.maxAttempts ?? 2,
      ...(overrides.config ?? {}),
    },
  });
}

test('端到端非流式 /v1/messages：上游收到标准 OpenAI 体 + WB 头族，客户端拿到 Anthropic JSON（usage 透传）', async (t) => {
  const stub = await startStub(t, (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(OK_SSE);
  });
  const pool = makePool(stub);
  const { db, full } = seedDb({ name: 'dev', pools: ['workbuddy-cn'] });
  const { base } = await startGateway(t, { pools: [pool], db });

  const res = await fetch(`${base}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': full },
    body: JSON.stringify({
      model: 'workbuddy-cn/glm-5.2',
      max_tokens: 64,
      system: 'you are a bot',
      messages: [{ role: 'user', content: 'hi' }],
    }),
  });
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.equal(body.type, 'message');
  assert.deepEqual(body.content, [{ type: 'text', text: 'Hello world' }]);
  assert.equal(body.stop_reason, 'end_turn');
  assert.deepEqual(body.usage, { input_tokens: 12, output_tokens: 3 }, 'usage 透传');

  const rec = stub.requests.find((r) => r.url === CHAT_PATH);
  assert.ok(rec, 'chat 请求应打到桩');
  assert.equal(rec.headers['x-product-code'], 'codebuddy');
  assert.equal(rec.headers['authorization'], 'Bearer at-1');
  assert.equal(rec.headers['x-user-id'], '10001');
  assert.equal(rec.headers['x-domain'], 'd.example');
  assert.equal(rec.headers['accept'], 'text/event-stream');

  const payload = JSON.parse(rec.body);
  assert.equal(payload.model, 'glm-5.2', 'model 直传');
  assert.equal(payload.stream, true, 'stream 固定 true（非流式由网关聚合）');
  assert.deepEqual(payload.messages, [
    { role: 'system', content: 'you are a bot' },
    { role: 'user', content: 'hi' },
  ], 'system 位置 + Anthropic→OpenAI messages（M2 转换器）');
  assert.equal(payload.max_tokens, 64, '采样参数透传');
});

test('端到端流式：客户端逐事件收到 Anthropic SSE，字节语义正确（message_start…message_stop）', async (t) => {
  const stub = await startStub(t, (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(OK_SSE);
  });
  const pool = makePool(stub);
  const { db, full } = seedDb({ name: 'dev', pools: ['workbuddy-cn'] });
  const { base } = await startGateway(t, { pools: [pool], db });

  const res = await fetch(`${base}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': full },
    body: JSON.stringify({ model: 'workbuddy-cn/glm-5.2', max_tokens: 64, stream: true, messages: [{ role: 'user', content: 'hi' }] }),
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
  // usage 在 message_delta 里
  const delta = text.match(/^data: (\{"type":"message_delta".*)$/m);
  assert.ok(delta);
  assert.deepEqual(JSON.parse(delta[1]).usage, { input_tokens: 12, output_tokens: 3 });
});

test('流内业务信封（HTTP 200 里的 {"code","msg"}）→ 走完整分类出口，不裸 destroy', async (t) => {
  const stub = await startStub(t, (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end('data: {"code":500,"msg":"boom"}\n\n');
  });
  const accounts = [ACCOUNT(), { ...ACCOUNT(), id: 'wb-2', uid: '2', jwt: 'at-2' }];
  const pool = makePool(stub, { accounts });
  const { db, full } = seedDb({ name: 'dev', pools: ['workbuddy-cn'] });
  const { base } = await startGateway(t, { pools: [pool], db });

  const res = await fetch(`${base}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': full },
    body: JSON.stringify({ model: 'workbuddy-cn/glm-5.2', max_tokens: 64, messages: [{ role: 'user', content: 'hi' }] }),
  });
  assert.equal(res.status, 502, '流内 server 类 → 502 聚合出口（与 Trae 同形）');
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

test('tool 调用往返：Anthropic tools → OpenAI function，tool_calls 流 → Anthropic tool_use 块', async (t) => {
  const toolSse = openAiSse([
    { id: 'c1', object: 'chat.completion.chunk', model: 'glm-5.2', choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 't1', type: 'function', function: { name: 'get_weather', arguments: '{"city":' } }] }, finish_reason: null }] },
    { id: 'c1', object: 'chat.completion.chunk', model: 'glm-5.2', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"北京"}' } }] }, finish_reason: null }] },
    { id: 'c1', object: 'chat.completion.chunk', model: 'glm-5.2', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
  ]);
  const stub = await startStub(t, (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(toolSse);
  });
  const pool = makePool(stub);
  const out = await pool.sendCollect({
    req: { headers: {} },
    body: {
      model: 'glm-5.2',
      max_tokens: 64,
      tools: [{ name: 'get_weather', description: 'w', input_schema: { type: 'object' } }],
      messages: [{ role: 'user', content: 'weather?' }],
    },
    key: { id: 'k1' },
  });
  const msg = JSON.parse(out.bodyText);
  assert.equal(msg.stop_reason, 'tool_use');
  assert.deepEqual(msg.content, [{ type: 'tool_use', id: 't1', name: 'get_weather', input: { city: '北京' } }]);

  const payload = JSON.parse(stub.requests.find((r) => r.url === CHAT_PATH).body);
  assert.deepEqual(payload.tools, [{ type: 'function', function: { name: 'get_weather', description: 'w', parameters: { type: 'object' } } }]);
});
