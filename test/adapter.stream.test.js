import test from 'node:test';
import assert from 'node:assert/strict';
import { openaiSseToAnthropicEvents } from '../adapters/anthropic-to-openai.mjs';

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
