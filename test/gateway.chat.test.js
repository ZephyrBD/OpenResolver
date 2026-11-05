import test from 'node:test';
import assert from 'node:assert/strict';
import { startGateway, seedDb } from './helpers/gateway.mjs';
import { startStub } from './helpers/stub.mjs';
import { createZcodePool } from '../pools/zcode/index.mjs';

const PROFILE = {
  system: [{ type: 'text', text: 'OFFICIAL SYSTEM' }],
  max_tokens: 128000,
  tool_choice: { type: 'auto' },
  thinking: { type: 'enabled' },
  output_config: { effort: 'low' },
};

const ACCOUNTS = [{ id: 'z1', label: 'a1', jwt: 'jwt-1', uid: 'uid-1' }];

function makePool(stub, overrides = {}) {
  return createZcodePool({
    accounts: ACCOUNTS.map((a) => ({ ...a })),
    profile: PROFILE,
    config: { origin: stub.origin, appVersion: '3.16.3', maxAttempts: 2, ...overrides },
  });
}

const OPENAI_ASK = {
  model: 'zcode/GLM-5.3',
  messages: [
    { role: 'system', content: 'be terse' },
    { role: 'user', content: 'hi' },
  ],
  max_tokens: 100,
};

const ANTHROPIC_PONG = {
  id: 'msg_9',
  type: 'message',
  role: 'assistant',
  content: [{ type: 'text', text: 'pong' }],
  stop_reason: 'end_turn',
  usage: { input_tokens: 3, output_tokens: 1 },
};

test('non-stream chat.completions: upstream sees the converted Anthropic body, client sees chat.completion', async (t) => {
  const stub = await startStub(t, (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        ...ANTHROPIC_PONG,
        content: [
          { type: 'thinking', thinking: 'internal', signature: 'sig' },
          { type: 'text', text: 'pong' },
          { type: 'tool_use', id: 'call_1', name: 'get_weather', input: { city: 'Hangzhou' } },
        ],
        stop_reason: 'tool_use',
      }),
    );
  });
  const { base } = await startGateway(t, { pools: [makePool(stub)] });

  const res = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      ...OPENAI_ASK,
      tools: [
        {
          type: 'function',
          function: { name: 'get_weather', description: 'look up', parameters: { type: 'object' } },
        },
      ],
      tool_choice: 'auto',
    }),
  });
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /application\/json/);
  assert.equal(body.object, 'chat.completion');
  assert.equal(body.id, 'msg_9');
  assert.equal(body.model, 'zcode/GLM-5.3');
  assert.equal(body.choices[0].message.content, 'pong');
  assert.deepEqual(body.choices[0].message.tool_calls, [
    { id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Hangzhou"}' } },
  ]);
  assert.equal(body.choices[0].finish_reason, 'tool_calls');
  assert.deepEqual(body.usage, { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 });

  const sent = JSON.parse(stub.requests[0].body);
  assert.equal(sent.model, 'GLM-5.3');
  assert.equal(sent.stream, false);
  assert.deepEqual(sent.system, PROFILE.system);
  assert.equal(
    sent.messages[0].content,
    '<pi_system_instructions>\nbe terse\n</pi_system_instructions>\n\nhi',
    '入站 system 降级成首条 user 的 banner',
  );
  assert.deepEqual(sent.tools, [{ name: 'get_weather', description: 'look up', input_schema: { type: 'object' } }]);
});

test('non-stream chat.completions: an upstream SSE body is aggregated into one chat.completion', async (t) => {
  const sse = [
    'event: message_start',
    'data: {"type":"message_start","message":{"id":"msg_s1","type":"message","role":"assistant","model":"GLM-5.3","content":[],"stop_reason":null,"usage":{"input_tokens":7,"output_tokens":1}}}',
    '',
    'event: content_block_start',
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
    '',
    'event: content_block_delta',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"he"}}',
    '',
    'event: content_block_delta',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"llo"}}',
    '',
    'event: content_block_stop',
    'data: {"type":"content_block_stop","index":0}',
    '',
    'event: message_delta',
    'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}',
    '',
    'event: message_stop',
    'data: {"type":"message_stop"}',
    '',
  ].join('\n');
  const stub = await startStub(t, (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(sse);
  });
  const { base } = await startGateway(t, { pools: [makePool(stub)] });

  const res = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(OPENAI_ASK),
  });
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /application\/json/);
  assert.equal(body.object, 'chat.completion');
  assert.equal(body.choices[0].message.content, 'hello');
  assert.equal(body.choices[0].finish_reason, 'stop');
  assert.deepEqual(body.usage, { prompt_tokens: 7, completion_tokens: 2, total_tokens: 9 });
});

test('stream:true is rejected with 400 and a hint', async (t) => {
  const stub = await startStub(t, () => {
    throw new Error('不应打到上游');
  });
  const { base } = await startGateway(t, { pools: [makePool(stub)] });

  const res = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...OPENAI_ASK, stream: true }),
  });
  const body = await res.json();

  assert.equal(res.status, 400);
  assert.equal(body.error.type, 'invalid_request_error');
  assert.match(body.error.message, /暂不支持流式/);
  assert.match(body.error.message, /stream:false/);
  assert.equal(stub.requests.length, 0);
});

test('chat.completions error shapes match /v1/messages', async (t) => {
  const stub = await startStub(t, (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(ANTHROPIC_PONG));
  });
  const { db, full } = seedDb({ name: 'dev', pools: ['zcode'] });
  const { base } = await startGateway(t, { pools: [makePool(stub)], db, config: { maxBodyBytes: 128 } });

  const badKey = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': 'zsk_bogus' },
    body: JSON.stringify(OPENAI_ASK),
  });
  assert.equal(badKey.status, 401);
  assert.equal((await badKey.json()).error.type, 'authentication_error');

  const noPrefix = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': full },
    body: JSON.stringify({ ...OPENAI_ASK, model: 'GLM-5.3' }),
  });
  assert.equal(noPrefix.status, 400);
  assert.equal((await noPrefix.json()).error.type, 'invalid_request_error');

  const malformed = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': full },
    body: '{not json',
  });
  assert.equal(malformed.status, 400);

  const tooBig = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': full },
    body: JSON.stringify({ ...OPENAI_ASK, messages: [{ role: 'user', content: 'x'.repeat(200) }] }),
  });
  assert.equal(tooBig.status, 413);
});

test('pool.sendCollect returns {status, contentType, bodyText} without touching res', async (t) => {
  const stub = await startStub(t, (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(ANTHROPIC_PONG));
  });
  const pool = makePool(stub);
  const res = {};
  let wrote = false;
  const guarded = new Proxy(res, {
    get(target, prop) {
      if (prop === 'writeHead' || prop === 'write' || prop === 'end') {
        return (...args) => {
          wrote = true;
          throw new Error(`sendCollect 不应写 res（${String(prop)}）`);
        };
      }
      return target[prop];
    },
  });

  const out = await pool.sendCollect({
    req: { headers: {} },
    res: guarded,
    body: { model: 'GLM-5.3', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] },
  });

  assert.equal(wrote, false);
  assert.deepEqual(
    { status: out.status, contentType: out.contentType },
    { status: 200, contentType: 'application/json' },
  );
  assert.deepEqual(JSON.parse(out.bodyText), ANTHROPIC_PONG);
});
