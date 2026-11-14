import test from 'node:test';
import assert from 'node:assert/strict';
import { openaiSseToAnthropicEvents } from '../adapters/anthropic-to-openai.mjs';
import { anthropicEventsToOpenaiChunks } from '../adapters/openai-to-anthropic.mjs';

function chunk(id, delta, extra = {}) {
  return { id, model: 'gpt-x', choices: [{ index: 0, delta, finish_reason: null, ...extra }], ...extra };
}

function collect(events) {
  return events.map((e) => JSON.parse(JSON.stringify(e)));
}

test('emits an Anthropic event sequence from an OpenAI chunk stream (text + two tools + usage)', async () => {
  function* source() {
    yield { event: 'message', data: JSON.stringify(chunk('c1', { role: 'assistant', content: 'He' })) };
    yield { event: 'message', data: JSON.stringify(chunk('c1', { content: 'llo' })) };
    yield { event: 'message', data: JSON.stringify(chunk('c1', { content: ' world' })) };
    yield {
      event: 'message',
      data: JSON.stringify(chunk('c1', { tool_calls: [{ index: 0, id: 'call_a', type: 'function', function: { name: 'get_weather', arguments: '{"ci' } }] })),
    };
    yield {
      event: 'message',
      data: JSON.stringify(chunk('c1', { tool_calls: [{ index: 0, function: { arguments: 'ty":"HZ"}' } }] })),
    };
    yield {
      event: 'message',
      data: JSON.stringify(chunk('c1', { tool_calls: [{ index: 1, id: 'call_b', type: 'function', function: { name: 'get_time', arguments: '{}' } }] })),
    };
    yield { event: 'message', data: JSON.stringify(chunk('c1', {}, { finish_reason: 'tool_calls' })) };
    yield { event: 'message', data: JSON.stringify({ id: 'c1', model: 'gpt-x', choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } }) };
    yield { event: 'message', data: '[DONE]' };
  }

  const events = collect(await Array.fromAsync(openaiSseToAnthropicEvents(source(), 'GLM-5.3')));

  assert.deepEqual(events, [
    {
      type: 'message_start',
      message: {
        id: 'c1',
        type: 'message',
        role: 'assistant',
        model: 'gpt-x',
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'He' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'llo' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ' world' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'call_a', name: 'get_weather', input: {} } },
    { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"ci' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: 'ty":"HZ"}' } },
    { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'call_b', name: 'get_time', input: {} } },
    { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{}' } },
    { type: 'content_block_stop', index: 1 },
    { type: 'content_block_stop', index: 2 },
    {
      type: 'message_delta',
      delta: { stop_reason: 'tool_use', stop_sequence: null },
      usage: { input_tokens: 10, output_tokens: 5 },
    },
    { type: 'message_stop' },
  ]);
});

test('assigns Anthropic block indexes by arrival order when OpenAI tool indexes are out of order', async () => {
  function* source() {
    yield {
      event: 'message',
      data: JSON.stringify(chunk('c2', { tool_calls: [{ index: 1, id: 'call_b', type: 'function', function: { name: 'get_time', arguments: '{}' } }] })),
    };
    yield {
      event: 'message',
      data: JSON.stringify(chunk('c2', { tool_calls: [{ index: 0, id: 'call_a', type: 'function', function: { name: 'get_weather', arguments: '{"x":1}' } }] })),
    };
    yield { event: 'message', data: JSON.stringify(chunk('c2', {}, { finish_reason: 'tool_calls' })) };
    yield { event: 'message', data: '[DONE]' };
  }

  const events = collect(await Array.fromAsync(openaiSseToAnthropicEvents(source(), 'GLM-5.3')));

  assert.deepEqual(events, [
    {
      type: 'message_start',
      message: {
        id: 'c2',
        type: 'message',
        role: 'assistant',
        model: 'gpt-x',
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    },
    { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'call_b', name: 'get_time', input: {} } },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{}' } },
    { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'call_a', name: 'get_weather', input: {} } },
    { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"x":1}' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_stop', index: 1 },
    {
      type: 'message_delta',
      delta: { stop_reason: 'tool_use', stop_sequence: null },
      usage: { input_tokens: 0, output_tokens: 0 },
    },
    { type: 'message_stop' },
  ]);
});

test('maps finish_reason stop to end_turn and closes an unclosed text block at [DONE]', async () => {
  function* source() {
    yield { event: 'message', data: JSON.stringify(chunk('c3', { content: 'bye' })) };
    yield { event: 'message', data: JSON.stringify(chunk('c3', {}, { finish_reason: 'stop' })) };
    yield { event: 'message', data: '[DONE]' };
  }

  const events = collect(await Array.fromAsync(openaiSseToAnthropicEvents(source(), 'GLM-5.3')));

  assert.deepEqual(
    events.slice(-3),
    [
      { type: 'content_block_stop', index: 0 },
      {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: { input_tokens: 0, output_tokens: 0 },
      },
      { type: 'message_stop' },
    ],
  );
  assert.deepEqual(events[0].type, 'message_start');
  assert.deepEqual(events.slice(1, 3), [
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'bye' } },
  ]);
});

// ---- WB 上游 tool_call delta 缺 index/id/name 的防御 ----

test('缺 index/id 的 tool_call delta 合成 id 并把连续参数增量并入同一块', async () => {
  function* source() {
    yield {
      event: 'message',
      data: JSON.stringify(chunk('c4', { tool_calls: [{ function: { name: 'get_weather', arguments: '{"ci' } }] })),
    };
    yield {
      event: 'message',
      data: JSON.stringify(chunk('c4', { tool_calls: [{ function: { arguments: 'ty":"HZ"}' } }] })),
    };
    yield { event: 'message', data: JSON.stringify(chunk('c4', {}, { finish_reason: 'tool_calls' })) };
    yield { event: 'message', data: '[DONE]' };
  }

  const events = collect(await Array.fromAsync(openaiSseToAnthropicEvents(source(), 'GLM-5.3')));

  const starts = events.filter((e) => e.type === 'content_block_start');
  assert.equal(starts.length, 1);
  assert.match(starts[0].content_block.id, /^toolu_gw_\d+$/);
  assert.equal(starts[0].content_block.name, 'get_weather');
  const deltas = events.filter((e) => e.type === 'content_block_delta');
  assert.deepEqual(deltas.map((d) => d.delta.partial_json), ['{"ci', 'ty":"HZ"}']);
  assert.deepEqual(deltas.map((d) => d.index), [0, 0]);
  assert.equal(events.at(-2).delta.stop_reason, 'tool_use');
});

test('缺 index 但带 id 的 tool_call delta 按 id 聚块，缺失的 name 兜底为空串', async () => {
  function* source() {
    yield {
      event: 'message',
      data: JSON.stringify(chunk('c5', { tool_calls: [{ id: 'call_x', type: 'function', function: { arguments: '{"a":1}' } }] })),
    };
    yield {
      event: 'message',
      data: JSON.stringify(chunk('c5', { tool_calls: [{ id: 'call_x', function: { arguments: '}' } }] })),
    };
    yield {
      event: 'message',
      data: JSON.stringify(chunk('c5', { tool_calls: [{ id: 'call_y', type: 'function', function: { name: 'g', arguments: '' } }] })),
    };
    yield { event: 'message', data: JSON.stringify(chunk('c5', {}, { finish_reason: 'tool_calls' })) };
    yield { event: 'message', data: '[DONE]' };
  }

  const events = collect(await Array.fromAsync(openaiSseToAnthropicEvents(source(), 'GLM-5.3')));

  const starts = events.filter((e) => e.type === 'content_block_start');
  assert.deepEqual(
    starts.map((s) => [s.content_block.id, s.content_block.name]),
    [['call_x', ''], ['call_y', 'g']],
  );
  assert.deepEqual(
    events.filter((e) => e.type === 'content_block_delta').map((d) => [d.index, d.delta.partial_json]),
    [[0, '{"a":1}'], [0, '}']],
  );
});

function anthropicEventSource(events) {
  return events;
}

test('anthropicEventsToOpenaiChunks: text 流产出 role/内容/finish/usage 帧', async () => {
  const source = anthropicEventSource([
    { type: 'message_start', message: { id: 'msg_1', usage: { input_tokens: 4, output_tokens: 1 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'he' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'llo' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'hidden' } },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } },
    { type: 'message_stop' },
  ]);

  const chunks = await Array.fromAsync(anthropicEventsToOpenaiChunks(source, 'GLM-5.3'));

  assert.equal(chunks.length, 5);
  assert.ok(chunks.every((c) => c.object === 'chat.completion.chunk' && c.id === 'msg_1' && c.model === 'GLM-5.3'));
  assert.deepEqual(chunks[0].choices[0].delta, { role: 'assistant', content: '' });
  assert.equal(chunks[1].choices[0].delta.content, 'he');
  assert.equal(chunks[2].choices[0].delta.content, 'llo');
  assert.deepEqual(chunks[3].choices[0].delta, {});
  assert.equal(chunks[3].choices[0].finish_reason, 'stop');
  assert.deepEqual(chunks[4].choices, []);
  assert.deepEqual(chunks[4].usage, { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 });
});

test('anthropicEventsToOpenaiChunks: tool_use 块按出现顺序映射 tool_calls index，增量拼接 arguments', async () => {
  const source = anthropicEventSource([
    { type: 'message_start', message: { id: 'msg_2', usage: { input_tokens: 3, output_tokens: 1 } } },
    { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'call_a', name: 'f1' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"x":' } },
    { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'call_b', name: 'f2' } },
    { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{}' } },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
    { type: 'message_stop' },
  ]);

  const chunks = await Array.fromAsync(anthropicEventsToOpenaiChunks(source, 'GLM-5.3'));

  const deltas = chunks.flatMap((c) => c.choices[0]?.delta?.tool_calls ?? []);
  assert.deepEqual(
    deltas.map((tc) => tc.index),
    [0, 0, 1, 1],
  );
  assert.equal(deltas[0].id, 'call_a');
  assert.equal(deltas[0].function.name, 'f1');
  assert.equal(deltas[1].function.arguments, '{"x":');
  assert.equal(deltas[2].id, 'call_b');
  assert.equal(deltas[3].function.arguments, '{}');
  const finish = chunks.find((c) => c.choices[0]?.finish_reason);
  assert.equal(finish.choices[0].finish_reason, 'tool_calls');
});
