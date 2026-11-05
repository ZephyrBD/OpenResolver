import test from 'node:test';
import assert from 'node:assert/strict';
import { createTraeDecoder, classifyTraeStreamError, TraeStreamError, msgIndicatesInputTooLarge } from '../pools/trae/stream.mjs';
import { createSseParser } from '../adapters/sse-reader.mjs';

/** mulberry32：固定种子，保证边界切分点可复现。 */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t ^ (t >>> 7)) | 0;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function feed(decoder, text) {
  const parser = createSseParser();
  const events = [];
  let done = false;
  for (const { event, data } of [...parser.push(text), ...parser.drain()]) {
    const r = decoder.pushEvent(event, data);
    events.push(...r.events);
    if (r.done) done = true;
  }
  events.push(...decoder.end());
  return { events, done };
}

// SOLO 私有 SSE fixture（vendor/cpa-trae/trae/upstream/solosse.go:3-23 事件形状）：
// 含 metadata / timing_cost / output（reasoning + text + tool_calls 分片）/ extra_info /
// token_usage / done。id: 行由 sse-reader 忽略。
const FIXTURE = [
  'id:1',
  'event:metadata',
  'data:{"model":"","session_id":"s-1","prompt_completion_id":0}',
  '',
  'id:2',
  'event:timing_cost',
  'data:{"name":"llm_raw_chat_v2","cost":16}',
  '',
  'event:output',
  'data:{"response":"","reasoning_content":"let me think"}',
  '',
  'event:output',
  'data:{"response":"","reasoning_content":" more"}',
  '',
  'event:output',
  'data:{"response":"Hello"}',
  '',
  'event:output',
  'data:{"response":" world"}',
  '',
  'event:output',
  'data:{"tool_calls":[{"index":0,"id":"call_1","type":"function","function_call":{"name":"get_weather","arguments":"{\\"ci"}}]}',
  '',
  'event:output',
  'data:{"tool_calls":[{"index":0,"function_call":{"arguments":"ty\\":\\"SZ\\"}"}}]}',
  '',
  'event:extra_info',
  'data:{"reasoning_content":"full chain"}',
  '',
  'event:token_usage',
  'data:{"prompt_tokens":21,"completion_tokens":142,"total_tokens":163,"reasoning_tokens":135}',
  '',
  'event:done',
  'data:{"finish_reason":"tool_calls"}',
  '',
  '',
].join('\n');

test('完整 SOLO SSE fixture → Anthropic 事件序列逐事件 deepEqual', () => {
  const { events, done } = feed(createTraeDecoder({ model: 'glm-5.2' }), FIXTURE);
  assert.equal(done, true);
  assert.deepEqual(events, [
    {
      type: 'message_start',
      message: {
        id: 'msg_trae',
        type: 'message',
        role: 'assistant',
        model: 'glm-5.2',
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    },
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'let me think' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: ' more' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Hello' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: ' world' } },
    { type: 'content_block_stop', index: 1 },
    { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'call_1', name: 'get_weather', input: {} } },
    { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"ci' } },
    { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: 'ty":"SZ"}' } },
    { type: 'content_block_stop', index: 2 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { input_tokens: 21, output_tokens: 142 } },
    { type: 'message_stop' },
  ]);
});

test('error 事件三分类：1005/4008 → quota_exhausted；4001 → 请求级 400 不冷却；其它 → client', () => {
  const quota = classifyTraeStreamError(1005, 'exceed quota limit');
  assert.equal(quota.kind, 'quota_exhausted');
  assert.equal(quota.retryable, true);
  assert.equal(classifyTraeStreamError(4008, 'Your requests have exceeded the quota').kind, 'quota_exhausted');

  const mismatch = classifyTraeStreamError(4001, "We're sorry, the param is invalid.");
  assert.equal(mismatch.kind, 'client');
  assert.equal(mismatch.retryable, false, '4001 换任何账号结果相同 → 不重试');
  assert.equal(mismatch.httpStatus, 400);
  assert.equal(mismatch.inputTooLarge, false);

  const other = classifyTraeStreamError(4023, 'model is unknown');
  assert.equal(other.kind, 'client');
  assert.equal(other.retryable, true, '其它 code 归 client，可换号重试');
});

test('"prompt is too long" 文案优先于 4001 分类（vendor v0.12.50 顺序敏感）', () => {
  const cls = classifyTraeStreamError(4001, 'prompt is too long: 300000 tokens > 200000 maximum');
  assert.equal(cls.kind, 'client');
  assert.equal(cls.httpStatus, 400);
  assert.equal(cls.inputTooLarge, true, '过大文案标记优先于模型不匹配');
  assert.equal(msgIndicatesInputTooLarge('Your request exceeded maximum context length'), true);
  assert.equal(msgIndicatesInputTooLarge('We are sorry, the param is invalid.'), false);

  assert.throws(
    () => feed(createTraeDecoder({ model: 'm' }), 'event:error\ndata:{"code":4001,"message":"prompt is too long"}\n\n'),
    (err) => err instanceof TraeStreamError && err.cls.inputTooLarge === true,
  );
});

test('error 事件在 pushEvent 时抛 TraeStreamError，携带分类', () => {
  const d = createTraeDecoder({ model: 'm' });
  assert.throws(
    () => d.pushEvent('error', JSON.stringify({ code: 1005, message: 'exceed quota limit' })),
    (err) => err instanceof TraeStreamError && err.cls.kind === 'quota_exhausted',
  );
});

test('任意字节边界切块等价（mulberry32，20 个切点 × 5 个种子）', () => {
  const baseline = feed(createTraeDecoder({ model: 'glm-5.2' }), FIXTURE).events;
  for (const seed of [1, 7, 42, 2026, 97531]) {
    const r = rng(seed);
    const cuts = Array.from({ length: 20 }, () => Math.floor(r() * FIXTURE.length)).sort((a, b) => a - b);
    const parser = createSseParser();
    const decoder = createTraeDecoder({ model: 'glm-5.2' });
    const events = [];
    let prev = 0;
    for (const p of [...cuts, FIXTURE.length]) {
      for (const { event, data } of parser.push(FIXTURE.slice(prev, p))) {
        events.push(...decoder.pushEvent(event, data).events);
      }
      prev = p;
    }
    for (const { event, data } of parser.drain()) {
      events.push(...decoder.pushEvent(event, data).events);
    }
    events.push(...decoder.end());
    assert.deepEqual(events, baseline, `seed=${seed}`);
  }
});

test('usage 换算：prompt_tokens→input_tokens、completion_tokens→output_tokens、reasoning_tokens 丢弃不伪造', () => {
  const { events } = feed(
    createTraeDecoder({ model: 'm' }),
    'event:output\ndata:{"response":"hi"}\n\nevent:token_usage\ndata:{"prompt_tokens":10,"completion_tokens":3,"total_tokens":13,"reasoning_tokens":99}\n\nevent:done\ndata:{"finish_reason":"stop"}\n\n',
  );
  const delta = events.find((e) => e.type === 'message_delta');
  assert.deepEqual(delta.usage, { input_tokens: 10, output_tokens: 3 });
  const message = events.find((e) => e.type === 'message_start').message;
  assert.equal(message.model, 'm');
});

test('无 done 收尾：end() 兜底补 stop 事件序列；finish_reason 映射 stop/tool_calls/length', () => {
  const { events, done } = feed(createTraeDecoder({ model: 'm' }), 'event:output\ndata:{"response":"hi"}\n\n');
  assert.equal(done, false);
  assert.deepEqual(events[events.length - 3].type, 'content_block_stop');
  assert.equal(events[events.length - 2].delta.stop_reason, 'end_turn');
  assert.equal(events[events.length - 1].type, 'message_stop');

  const map = (finish) =>
    feed(createTraeDecoder({ model: 'm' }), `event:done\ndata:{"finish_reason":"${finish}"}\n\n`).events.find(
      (e) => e.type === 'message_delta',
    ).delta.stop_reason;
  assert.equal(map('stop'), 'end_turn');
  assert.equal(map('tool_calls'), 'tool_use');
  assert.equal(map('length'), 'max_tokens');
});
