import test from 'node:test';
import assert from 'node:assert/strict';
import {
  chatCompletionsToMessages,
  anthropicToChatCompletion,
  aggregateAnthropicSseToChatCompletion,
} from '../adapters/openai-to-anthropic.mjs';
import { messagesToChatCompletions } from '../adapters/anthropic-to-openai.mjs';
import { createSseParser } from '../adapters/sse-reader.mjs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

test('merges consecutive system messages into a top-level system array', () => {
  const out = chatCompletionsToMessages({
    messages: [
      { role: 'system', content: 'be terse' },
      { role: 'system', content: 'reply in Chinese' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'yo' },
      { role: 'user', content: 'go on' },
    ],
  });

  assert.deepEqual(out.system, ['be terse', 'reply in Chinese']);
  assert.deepEqual(out.messages, [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'yo' },
    { role: 'user', content: 'go on' },
  ]);
});

test('maps tool_calls to tool_use blocks, degrading bad JSON arguments to {}', () => {
  const out = chatCompletionsToMessages({
    messages: [
      { role: 'user', content: 'weather?' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Hangzhou"}' } },
          { id: 'call_2', type: 'function', function: { name: 'broken', arguments: '{oops' } },
        ],
      },
    ],
  });

  assert.deepEqual(out.messages, [
    { role: 'user', content: 'weather?' },
    {
      role: 'assistant',
      content: [
        { type: 'tool_use', id: 'call_1', name: 'get_weather', input: { city: 'Hangzhou' } },
        { type: 'tool_use', id: 'call_2', name: 'broken', input: {} },
      ],
    },
  ]);
});

test('merges consecutive tool messages into one user message of tool_result blocks', () => {
  const out = chatCompletionsToMessages({
    messages: [
      { role: 'user', content: 'q' },
      {
        role: 'assistant',
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'f', arguments: '{}' } }],
      },
      { role: 'tool', tool_call_id: 'call_1', content: 'result one' },
      { role: 'tool', tool_call_id: 'call_9', content: [{ type: 'text', text: 'part a' }, { type: 'text', text: 'part b' }] },
      { role: 'user', content: 'thanks' },
    ],
  });

  assert.deepEqual(out.messages, [
    { role: 'user', content: 'q' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'call_1', name: 'f', input: {} }] },
    {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'call_1', content: 'result one' },
        { type: 'tool_result', tool_use_id: 'call_9', content: 'part apart b' },
      ],
    },
    { role: 'user', content: 'thanks' },
  ]);
});

test('maps tool_choice in all three spellings plus required', () => {
  const body = { messages: [] };
  assert.deepEqual(chatCompletionsToMessages({ ...body, tool_choice: 'auto' }).tool_choice, { type: 'auto' });
  assert.deepEqual(chatCompletionsToMessages({ ...body, tool_choice: 'none' }).tool_choice, { type: 'none' });
  assert.deepEqual(chatCompletionsToMessages({ ...body, tool_choice: 'required' }).tool_choice, { type: 'any' });
  assert.deepEqual(
    chatCompletionsToMessages({ ...body, tool_choice: { type: 'function', function: { name: 'f' } } }).tool_choice,
    { type: 'tool', name: 'f' },
  );
});

test('converts tools to input_schema shape and ignores non-function tools', () => {
  const out = chatCompletionsToMessages({
    messages: [],
    tools: [
      {
        type: 'function',
        function: { name: 'get_weather', description: 'look up weather', parameters: { type: 'object', properties: {} } },
      },
      { type: 'web_search', web_search: { extra: true } },
    ],
  });

  assert.deepEqual(out.tools, [
    { name: 'get_weather', description: 'look up weather', input_schema: { type: 'object', properties: {} } },
  ]);
});

test('passes max_tokens, temperature, top_p, stop (string to array) and stream through', () => {
  const out = chatCompletionsToMessages({
    messages: [],
    max_tokens: 256,
    temperature: 0.5,
    top_p: 0.9,
    stop: 'END',
    stream: false,
  });

  assert.deepEqual(out, { messages: [], max_tokens: 256, temperature: 0.5, top_p: 0.9, stop: ['END'], stream: false });
});

test('converts a non-stream Anthropic message to chat.completion (table-driven stop_reason map)', () => {
  const CASES = [
    ['end_turn', 'stop'],
    ['max_tokens', 'length'],
    ['tool_use', 'tool_calls'],
    ['stop_sequence', 'stop'],
    [null, null],
  ];
  for (const [stopReason, expected] of CASES) {
    const out = anthropicToChatCompletion(
      {
        id: 'msg_1',
        role: 'assistant',
        content: [{ type: 'text', text: 'hi' }],
        stop_reason: stopReason,
        usage: { input_tokens: 3, output_tokens: 5 },
      },
      'GLM-5.3',
    );
    assert.equal(out.choices[0].finish_reason, expected, `stop_reason ${stopReason}`);
  }
});

test('converts text, tool_use, thinking-drop and usage in a non-stream response', () => {
  const out = anthropicToChatCompletion(
    {
      id: 'msg_2',
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'internal', signature: 'sig' },
        { type: 'text', text: 'part 1 ' },
        { type: 'text', text: 'part 2' },
        { type: 'tool_use', id: 'call_1', name: 'get_weather', input: { city: 'Hangzhou' } },
      ],
      stop_reason: 'tool_use',
      usage: { input_tokens: 12, output_tokens: 34 },
    },
    'zcode/GLM-5.3',
  );

  assert.equal(out.id, 'msg_2');
  assert.equal(out.object, 'chat.completion');
  assert.equal(out.model, 'zcode/GLM-5.3');
  assert.equal(out.choices.length, 1);
  assert.equal(out.choices[0].index, 0);
  assert.equal(out.choices[0].message.role, 'assistant');
  assert.equal(out.choices[0].message.content, 'part 1 part 2');
  assert.deepEqual(out.choices[0].message.tool_calls, [
    {
      id: 'call_1',
      type: 'function',
      function: { name: 'get_weather', arguments: '{"city":"Hangzhou"}' },
    },
  ]);
  assert.deepEqual(out.usage, { prompt_tokens: 12, completion_tokens: 34, total_tokens: 46 });
});

test('aggregates a whole Anthropic SSE fixture into one chat.completion', async () => {
  const fixture = readFileSync(join(here, 'fixtures', 'anthropic-sse.txt'), 'utf8');
  function* events() {
    const p = createSseParser();
    for (const ev of p.push(fixture)) yield ev;
    for (const ev of p.drain()) yield ev;
  }

  const out = await aggregateAnthropicSseToChatCompletion(events(), 'GLM-5.3');

  assert.equal(out.id, 'msg_agg1');
  assert.equal(out.object, 'chat.completion');
  assert.equal(out.choices[0].finish_reason, 'tool_calls');
  assert.equal(out.choices[0].message.content, '杭州今天多云。');
  assert.deepEqual(out.choices[0].message.tool_calls, [
    {
      id: 'toolu_01',
      type: 'function',
      function: { name: 'get_weather', arguments: '{"city":"杭州","unit":"celsius"}' },
    },
  ]);
  assert.deepEqual(out.usage, { prompt_tokens: 42, completion_tokens: 57, total_tokens: 99 });
});

test('keeps the raw joined partial_json when a tool arguments stream is invalid JSON', async () => {
  function* events() {
    yield { event: 'content_block_start', data: '{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"t1","name":"f"}}' };
    yield { event: 'content_block_delta', data: '{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{bad"}}' };
    yield { event: 'content_block_delta', data: '{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"_json"}' + '}' };
    yield { event: 'message_delta', data: '{"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":3}}' };
    yield { event: 'message_stop', data: '{"type":"message_stop"}' };
  }

  const out = await aggregateAnthropicSseToChatCompletion(events(), 'GLM-5.3');
  assert.deepEqual(out.choices[0].message.tool_calls, [
    { id: 't1', type: 'function', function: { name: 'f', arguments: '{bad_json' } },
  ]);
});

test('drops an assistant message with null content and no tool_calls', () => {
  const out = chatCompletionsToMessages({
    messages: [
      { role: 'user', content: 'a' },
      { role: 'assistant', content: null },
      { role: 'user', content: 'b' },
    ],
  });

  assert.deepEqual(out.messages, [
    { role: 'user', content: 'a' },
    { role: 'user', content: 'b' },
  ]);
});

test('drops empty-string assistant and user messages but keeps an empty assistant that carries tool_calls', () => {
  const out = chatCompletionsToMessages({
    messages: [
      { role: 'user', content: '' },
      { role: 'assistant', content: '' },
      { role: 'user', content: 'q' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'f', arguments: '{}' } }],
      },
    ],
  });

  assert.deepEqual(out.messages, [
    { role: 'user', content: 'q' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'call_1', name: 'f', input: {} }] },
  ]);
});

/** mulberry32：固定种子，切块点可复现（与 sse-reader 测试同款）。 */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('chunked aggregation equals whole-input aggregation for the same SSE fixture', async () => {
  const fixture = readFileSync(join(here, 'fixtures', 'anthropic-sse.txt'), 'utf8');

  function* eventsOf(text) {
    const p = createSseParser();
    for (const ev of p.push(text)) yield ev;
    for (const ev of p.drain()) yield ev;
  }

  const whole = await aggregateAnthropicSseToChatCompletion(eventsOf(fixture), 'GLM-5.3');

  const r = rng(20261104);
  const points = Array.from({ length: 25 }, () => Math.floor(r() * fixture.length)).sort((x, y) => x - y);
  assert.ok(
    points.some((pt) => fixture[pt - 1] !== '\n'),
    '自证：至少一个切点落在行中间，切块喂入才真正有杀伤力',
  );
  const parser = createSseParser();
  async function* chunkedEvents() {
    let prev = 0;
    for (const pt of points) {
      for (const ev of parser.push(fixture.slice(prev, pt))) yield ev;
      prev = pt;
    }
    for (const ev of parser.push(fixture.slice(prev))) yield ev;
    for (const ev of parser.drain()) yield ev;
  }
  const chunked = await aggregateAnthropicSseToChatCompletion(chunkedEvents(), 'GLM-5.3');

  for (const out of [whole, chunked]) {
    assert.equal(Number.isInteger(out.created), true);
    delete out.created; // created 是秒级时间戳，聚合两次可能跨秒，剥离后比较其余字段
  }
  assert.deepEqual(chunked, whole);
});

// ---- 往返等价 ----

function semanticOfAnthropic(body) {
  const sys = typeof body.system === 'string' ? body.system : (body.system || []).map((b) => (typeof b === 'string' ? b : b?.text ?? '')).join('\n');
  const msgs = (body.messages || []).map((m) => ({
    role: m.role,
    text: typeof m.content === 'string' ? m.content : '',
    blocks: Array.isArray(m.content) ? m.content : [],
  }));
  return { sys, msgs, tools: body.tools || [] };
}

function semanticOfOpenAi(body) {
  const sys = (body.messages || []).filter((m) => m.role === 'system').map((m) => m.content).join('\n');
  return { sys, messages: (body.messages || []).filter((m) => m.role !== 'system'), tools: body.tools || [] };
}

test('round-trip Anthropic -> OpenAI -> Anthropic keeps text, tools and tool results', () => {
  const original = {
    system: [{ type: 'text', text: 'be terse' }],
    messages: [
      { role: 'user', content: 'weather in Hangzhou?' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'let me check' },
          { type: 'tool_use', id: 'toolu_01', name: 'get_weather', input: { city: 'Hangzhou' } },
        ],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_01', content: '28C sunny' }],
      },
      { role: 'user', content: 'and tomorrow?' },
    ],
    tools: [{ name: 'get_weather', description: 'look up', input_schema: { type: 'object' } }],
  };

  const openai = messagesToChatCompletions(structuredClone(original));
  const back = chatCompletionsToMessages(openai);
  const a = semanticOfAnthropic(original);
  const b = semanticOfAnthropic(back);

  assert.equal(b.sys, a.sys);
  assert.deepEqual(b.tools.map((t) => [t.name, t.description, t.input_schema]), a.tools.map((t) => [t.name, t.description, t.input_schema]));
  assert.deepEqual(
    b.msgs.flatMap((m) => (m.blocks.length ? m.blocks : [{ role: m.role, text: m.text }])),
    a.msgs.flatMap((m) => (m.blocks.length ? m.blocks : [{ role: m.role, text: m.text }])),
  );
});

test('round-trip OpenAI -> Anthropic -> OpenAI keeps text, tool calls and tool results', () => {
  const original = {
    messages: [
      { role: 'system', content: 'be terse' },
      { role: 'user', content: 'weather in Hangzhou?' },
      {
        role: 'assistant',
        content: 'let me check',
        tool_calls: [
          { id: 'call_01', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Hangzhou"}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'call_01', content: '28C sunny' },
      { role: 'user', content: 'and tomorrow?' },
    ],
    tools: [
      { type: 'function', function: { name: 'get_weather', description: 'look up', parameters: { type: 'object' } } },
    ],
  };

  const anthropic = chatCompletionsToMessages(structuredClone(original));
  const back = messagesToChatCompletions(anthropic);
  const a = semanticOfOpenAi(original);
  const b = semanticOfOpenAi(back);

  assert.equal(b.sys, a.sys);
  assert.deepEqual(
    b.tools.map((t) => ({ name: t.function.name, description: t.function.description, parameters: t.function.parameters })),
    a.tools.map((t) => ({ name: t.function.name, description: t.function.description, parameters: t.function.parameters })),
  );
  assert.deepEqual(
    b.messages.map((m) =>
      m.role === 'assistant'
        ? { role: m.role, content: m.content, tool_calls: (m.tool_calls || []).map((c) => [c.id, c.function.name, JSON.parse(c.function.arguments)]) }
        : m.role === 'tool'
          ? { role: m.role, tool_call_id: m.tool_call_id, content: m.content }
          : { role: m.role, content: m.content },
    ),
    a.messages.map((m) =>
      m.role === 'assistant'
        ? { role: m.role, content: m.content, tool_calls: (m.tool_calls || []).map((c) => [c.id, c.function.name, JSON.parse(c.function.arguments)]) }
        : m.role === 'tool'
          ? { role: m.role, tool_call_id: m.tool_call_id, content: m.content }
          : { role: m.role, content: m.content },
    ),
  );
});
