import test from 'node:test';
import assert from 'node:assert/strict';
import { createQoderDecoder, QoderUpstreamError, stripThinkingTags, stripDsmlResidue } from '../pools/qoder/stream.mjs';
import { createSseParser } from '../adapters/sse-reader.mjs';

/** 构造双层 SSE 外层一行：envelope 包 inner JSON 字符串。 */
function envelopeLine(inner) {
  return `data: ${JSON.stringify({ statusCodeValue: 200, body: typeof inner === 'string' ? inner : JSON.stringify(inner) })}\n\n`;
}

const DONE_LINE = `data: ${JSON.stringify({ statusCodeValue: 200, body: '[DONE]' })}\n\n`;

function innerChunk(overrides = {}) {
  return { id: 'chatcmpl-1', model: 'qmodel_latest', choices: [{ index: 0, delta: {}, finish_reason: null }, ...[]], ...overrides };
}

/** 喂完整 SSE 文本，返回全部 Anthropic 事件。 */
function feed(text, { model = 'Qwen3.7-Max' } = {}) {
  const decoder = createQoderDecoder({ model });
  const events = [];
  for (const { data } of createSseParser().push(text)) {
    const r = decoder.pushData(data);
    events.push(...r.events);
    if (r.done) break;
  }
  events.push(...decoder.end());
  return events;
}

test('双层 SSE fixture → Anthropic 事件序列逐事件对齐（reasoning/content/tool/usage/finish）', () => {
  const inner = [
    innerChunk({ choices: [{ index: 0, delta: { reasoning_content: '<think>let me</think>' }, finish_reason: null }] }),
    innerChunk({ choices: [{ index: 0, delta: { content: 'Hello' }, finish_reason: null }] }),
    innerChunk({ choices: [{ index: 0, delta: { content: ' world' }, finish_reason: null }] }),
    innerChunk({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'get_weather', arguments: '' } }] }, finish_reason: null }] }),
    innerChunk({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"city":' } }] }, finish_reason: null }] }),
    innerChunk({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"HZ"}}' } }] }, finish_reason: null }] }),
    innerChunk({
      choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
      usage: { prompt_tokens: 100, completion_tokens: 7, total_tokens: 107, prompt_tokens_details: { cached_tokens: 10, cache_write_tokens: 5 } },
    }),
  ];
  const sse = inner.map(envelopeLine).join('') + DONE_LINE;
  const events = feed(sse);

  assert.deepEqual(events, [
    { type: 'message_start', message: { id: 'chatcmpl-1', type: 'message', role: 'assistant', model: 'qmodel_latest', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'let me' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Hello' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: ' world' } },
    { type: 'content_block_stop', index: 1 },
    { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'call_1', name: 'get_weather', input: {} } },
    { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"city":' } },
    { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '"HZ"}}' } },
    { type: 'content_block_stop', index: 2 },
    {
      type: 'message_delta',
      delta: { stop_reason: 'tool_use', stop_sequence: null },
      usage: { input_tokens: 85, output_tokens: 7, cache_read_input_tokens: 10, cache_creation_input_tokens: 5 },
    },
    { type: 'message_stop' },
  ]);
});

test('statusCodeValue !== 200 → 抛 classifyUpstreamError 形状的错误', () => {
  const decoder = createQoderDecoder({ model: 'm' });
  assert.throws(
    () => decoder.pushData(JSON.stringify({ statusCodeValue: 401, body: 'denied' })),
    (err) => err instanceof QoderUpstreamError && err.cls.kind === 'auth' && err.cls.retryable === false,
  );
  assert.throws(
    () => decoder.pushData(JSON.stringify({ statusCodeValue: 429, body: 'limited' })),
    (err) => err instanceof QoderUpstreamError && err.cls.kind === 'rate_limit' && err.cls.retryable === true,
  );
  assert.throws(
    () => decoder.pushData(JSON.stringify({ statusCodeValue: 51234, body: 'biz' })),
    (err) => err instanceof QoderUpstreamError && err.cls.kind === 'server' && /51234/.test(err.cls.message),
  );
});

test('坏 JSON 行（外层与内层）跳过继续', () => {
  const sse =
    'data: not-json\n\n' +
    envelopeLine({ statusCodeValue: 200, body: '{broken inner' }) +
    envelopeLine(innerChunk({ choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: null }] })) +
    DONE_LINE;
  const events = feed(sse);
  assert.deepEqual(
    events.filter((e) => e.type === 'content_block_delta'),
    [{ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } }],
  );
});

test('thinking 标签跨 chunk 剥离：<thi + nking> 分属两个 chunk', () => {
  const inner = [
    innerChunk({ choices: [{ index: 0, delta: { content: '<thi' }, finish_reason: null }] }),
    innerChunk({ choices: [{ index: 0, delta: { content: 'nking>hidden</thi' }, finish_reason: null }] }),
    innerChunk({ choices: [{ index: 0, delta: { content: 'nking>visible' }, finish_reason: null }] }),
  ];
  const events = feed(inner.map(envelopeLine).join('') + DONE_LINE);
  const thinking = events.filter((e) => e.delta?.type === 'thinking_delta').map((e) => e.delta.thinking).join('');
  const text = events.filter((e) => e.delta?.type === 'text_delta').map((e) => e.delta.text).join('');
  assert.equal(thinking, 'hidden');
  assert.equal(text, 'visible');
});

test('外层 data [DONE] 与 envelope.body [DONE] 都结束流（未 started 也补齐收尾事件）', () => {
  const a = feed('data: [DONE]\n\n');
  assert.deepEqual(a.map((e) => e.type), ['message_start', 'message_delta', 'message_stop']);
  const b = feed(DONE_LINE);
  assert.deepEqual(b.map((e) => e.type), ['message_start', 'message_delta', 'message_stop']);
});

test('任意字节边界切块：产出事件序列与整段一致', () => {
  const inner = [
    innerChunk({ choices: [{ index: 0, delta: { reasoning_content: 'think' }, finish_reason: null }] }),
    innerChunk({ choices: [{ index: 0, delta: { content: '<think>deep</think>answer' }, finish_reason: null }] }),
    innerChunk({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 't1', function: { name: 'f', arguments: '{"a":1}' } }] }, finish_reason: 'tool_calls' }] }),
  ];
  const text = inner.map(envelopeLine).join('') + DONE_LINE;

  const whole = feed(text);

  // mulberry32 固定种子切块
  let a = 1337;
  const rng = () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const points = Array.from({ length: 40 }, () => Math.floor(rng() * text.length)).sort((x, y) => x - y);
  const parser = createSseParser();
  const decoder = createQoderDecoder({ model: 'm' });
  const events = [];
  let prev = 0;
  let ended = false;
  const finish = () => {
    if (ended) return;
    ended = true;
    events.push(...decoder.end());
  };
  for (const p of [...points, text.length]) {
    for (const { data } of parser.push(text.slice(prev, p))) {
      const r = decoder.pushData(data);
      events.push(...r.events);
      if (r.done) {
        finish();
        break;
      }
    }
    prev = p;
    if (ended) break;
  }
  finish();
  assert.deepEqual(events, whole);
});

test('usage 换算：cached/cache_write 扣减进 input_tokens；无 details 时原样', () => {
  const mk = (details) =>
    feed(
      envelopeLine(innerChunk({
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: details },
      })) + DONE_LINE,
    ).find((e) => e.type === 'message_delta').usage;

  assert.deepEqual(mk({ cached_tokens: 30, cache_write_tokens: 10 }), { input_tokens: 60, output_tokens: 20, cache_read_input_tokens: 30, cache_creation_input_tokens: 10 });
  assert.deepEqual(mk({ cached_tokens: 30 }), { input_tokens: 70, output_tokens: 20, cache_read_input_tokens: 30 });
  assert.deepEqual(mk(undefined), { input_tokens: 100, output_tokens: 20 });
});

test('finish_reason 映射：stop→end_turn、length→max_tokens；有工具调用时强制 tool_use', () => {
  const reasonOf = (inner, extra = []) => {
    const events = feed([...extra, inner].map(envelopeLine).join('') + DONE_LINE);
    return events.find((e) => e.type === 'message_delta').delta.stop_reason;
  };
  assert.equal(reasonOf(innerChunk({ choices: [{ index: 0, delta: { content: 'x' }, finish_reason: 'stop' }] })), 'end_turn');
  assert.equal(reasonOf(innerChunk({ choices: [{ index: 0, delta: { content: 'x' }, finish_reason: 'length' }] })), 'max_tokens');
  assert.equal(
    reasonOf(innerChunk({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }), [
      innerChunk({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 't', function: { name: 'f' } }] }, finish_reason: null }] }),
    ]),
    'tool_use',
  );
});

test('F3（评审）：tool_calls arguments 先于 id 到达 → 无条件累计，start 时补发，拼接完整', () => {
  const sse =
    envelopeLine(innerChunk({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"a":' } }] }, finish_reason: null }] })) +
    envelopeLine(innerChunk({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 't1', function: { name: 'f', arguments: '1}' } }] }, finish_reason: 'tool_calls' }] })) +
    DONE_LINE;
  const events = feed(sse);

  const starts = events.filter((e) => e.type === 'content_block_start');
  assert.deepEqual(starts, [{ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 't1', name: 'f', input: {} } }]);
  const json = events
    .filter((e) => e.delta?.type === 'input_json_delta')
    .map((e) => e.delta.partial_json)
    .join('');
  assert.equal(json, '{"a":1}', 'start 前累计的片段必须补发，否则聚合丢参');
});

test('stripThinkingTags / stripDsmlResidue（源 :1323/:1333）', () => {
  assert.equal(stripThinkingTags('a<thinking>b</thinking>c<think>d</think>'), 'abcd');
  assert.equal(stripDsmlResidue('pre <|DSML x|> post<invoke name="f">'), 'pre  post');
  assert.equal(stripDsmlResidue('a\n\n\n\nb'), 'a\n\nb');
});
