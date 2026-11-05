import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTraePayload } from '../pools/trae/payload.mjs';
import { FUNCTION } from '../pools/trae/constants.mjs';

test('白名单：messages/function/stream/config_name/model 之外的未知字段全部丢弃', () => {
  const out = buildTraePayload(
    {
      model: 'glm-5.2',
      max_tokens: 64,
      messages: [{ role: 'user', content: 'hi' }],
      thinking: { type: 'enabled', budget_tokens: 1024 },
      stream_options: { include_usage: true },
      response_format: { type: 'json_object' },
      user: 'u-1',
      metadata: { conversation_id: 'c-1' },
      reasoning_effort: 'high',
      agent_type: 'coding',
    },
    'glm-5.2',
  );
  assert.deepEqual(Object.keys(out).sort(), ['config_name', 'function', 'max_tokens', 'messages', 'model', 'stream']);
  assert.equal(out.function, FUNCTION);
  assert.equal(out.stream, true, '上游强制 stream:true（非流式由网关聚合）');
  assert.equal(out.config_name, 'glm-5.2');
  assert.equal(out.model, 'glm-5.2');
});

test('content 归一化：字符串 → [{type:"text",text}] 块数组；system 提为消息', () => {
  const out = buildTraePayload(
    {
      model: 'glm-5.2',
      max_tokens: 16,
      system: 'be nice',
      messages: [{ role: 'user', content: 'hello' }],
    },
    'glm-5.2',
  );
  assert.deepEqual(out.messages, [
    { role: 'system', content: [{ type: 'text', text: 'be nice' }] },
    { role: 'user', content: [{ type: 'text', text: 'hello' }] },
  ]);
});

test('tools 归一化四规则：none 删 tools / auto+any 保留 / tool 提名 name / input_schema 序列化为 parameters 字符串', () => {
  const tools = [{ name: 'get_weather', description: 'w', input_schema: { type: 'object', properties: { city: { type: 'string' } } } }];

  const none = buildTraePayload(
    { model: 'm', max_tokens: 16, messages: [], tools, tool_choice: { type: 'none' } },
    'm',
  );
  assert.equal('tools' in none, false, 'tool_choice none → 删 tools');
  assert.equal('tool_choice' in none, false);

  const auto = buildTraePayload(
    { model: 'm', max_tokens: 16, messages: [], tools, tool_choice: { type: 'auto' } },
    'm',
  );
  assert.equal(auto.tool_choice, 'auto');
  assert.deepEqual(auto.tools, [
    {
      type: 'function',
      function: {
        name: 'get_weather',
        description: 'w',
        parameters: JSON.stringify(tools[0].input_schema),
      },
    },
  ]);

  const any = buildTraePayload(
    { model: 'm', max_tokens: 16, messages: [], tools, tool_choice: { type: 'any' } },
    'm',
  );
  assert.equal(any.tool_choice, 'required');

  const named = buildTraePayload(
    { model: 'm', max_tokens: 16, messages: [], tools, tool_choice: { type: 'tool', name: 'get_weather' } },
    'm',
  );
  assert.equal(named.tool_choice, 'get_weather');
});

test('assistant 的 tool_use → tool_calls[].function_call 重命名；tool_result → role:"tool" 消息', () => {
  const out = buildTraePayload(
    {
      model: 'm',
      max_tokens: 16,
      messages: [
        { role: 'user', content: 'weather?' },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'checking' },
            { type: 'tool_use', id: 'tu_1', name: 'get_weather', input: { city: 'SZ' } },
          ],
        },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'sunny' }] },
      ],
      tools: [{ name: 'get_weather', input_schema: { type: 'object' } }],
    },
    'm',
  );
  const assistant = out.messages[1];
  assert.deepEqual(assistant.content, [{ type: 'text', text: 'checking' }]);
  assert.deepEqual(assistant.tool_calls, [
    { id: 'tu_1', type: 'function', function_call: { name: 'get_weather', arguments: '{"city":"SZ"}' } },
  ]);
  assert.equal('function' in assistant.tool_calls[0], false);
  const toolMsg = out.messages[2];
  assert.deepEqual(toolMsg, {
    role: 'tool',
    tool_call_id: 'tu_1',
    content: [{ type: 'text', text: 'sunny' }],
  });
});

test('采样参数透传 + stop_sequences → stop + max_tokens 缺省补 1000000（vendor v0.12.48：防上游 128k 腰斩）', () => {
  const out = buildTraePayload(
    {
      model: 'm',
      temperature: 0.5,
      top_p: 0.9,
      presence_penalty: 0.1,
      frequency_penalty: 0.2,
      seed: 7,
      n: 1,
      stop_sequences: ['END'],
      messages: [],
    },
    'm',
  );
  assert.equal(out.temperature, 0.5);
  assert.equal(out.top_p, 0.9);
  assert.equal(out.presence_penalty, 0.1);
  assert.equal(out.frequency_penalty, 0.2);
  assert.equal(out.seed, 7);
  assert.equal(out.n, 1);
  assert.deepEqual(out.stop, ['END']);
  assert.equal(out.max_tokens, 1_000_000);

  const explicit = buildTraePayload({ model: 'm', max_tokens: 128, messages: [] }, 'm');
  assert.equal(explicit.max_tokens, 128, '显式 max_tokens 原样透传');
});
