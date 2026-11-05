import test from 'node:test';
import assert from 'node:assert/strict';
import { buildChatPayload, stableHash, stableChatRecordID, MAX_OUTPUT_TOKENS } from '../pools/qoder/payload.mjs';

const FIXED_UUID = '22222222-2222-4222-8222-222222222222';
const FIXED_NOW = 1_700_000_000_000;
const INJECT = { randomUUID: () => FIXED_UUID, now: () => FIXED_NOW };

const MODEL_CONFIG = { key: 'qmodel_latest', display_name: 'Qwen3.7-Max', is_reasoning: true, source: 'system' };

const ANTHROPIC_BODY = {
  model: 'Qwen3.7-Max',
  max_tokens: 100,
  system: 'be terse',
  messages: [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'call_1', name: 'get_weather', input: { city: 'HZ' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'sunny' }, { type: 'text', text: 'thanks' }] },
  ],
  tools: [{ name: 'get_weather', description: 'look up', input_schema: { type: 'object', properties: { city: { type: 'string' } } } }],
};

test('payload: system 进 messages[0] role:system，顶层 system 置空', () => {
  const payload = buildChatPayload(ANTHROPIC_BODY, MODEL_CONFIG, { userID: 'u-1', ...INJECT });
  assert.equal(payload.system, '');
  assert.equal(payload.messages[0].role, 'system');
  assert.equal(payload.messages[0].content, 'be terse');
  assert.equal(payload.messages[1].content, 'hi');
});

test('payload: model_config 整块进入；chat_context.modelConfig 对齐', () => {
  const payload = buildChatPayload(ANTHROPIC_BODY, MODEL_CONFIG, { userID: 'u-1', ...INJECT });
  assert.deepEqual(payload.model_config, MODEL_CONFIG);
  assert.deepEqual(payload.chat_context.extra.modelConfig, { key: 'qmodel_latest', is_reasoning: true });
  assert.equal(payload.chat_context.text, 'thanks', '最后一条 user 文本');
});

test('payload: parameters.enable_thinking 默认 false；max_tokens 钳制', () => {
  const payload = buildChatPayload(ANTHROPIC_BODY, MODEL_CONFIG, { userID: 'u-1', ...INJECT });
  assert.equal(payload.parameters.enable_thinking, false);
  assert.equal(payload.parameters.max_tokens, 100);
  const capped = buildChatPayload({ ...ANTHROPIC_BODY, max_tokens: 999_999 }, MODEL_CONFIG, { userID: 'u-1', ...INJECT });
  assert.equal(capped.parameters.max_tokens, MAX_OUTPUT_TOKENS);
});

test('payload: tools 转换（input_schema → parameters）', () => {
  const payload = buildChatPayload(ANTHROPIC_BODY, MODEL_CONFIG, { userID: 'u-1', ...INJECT });
  assert.deepEqual(payload.tools, [
    {
      type: 'function',
      function: {
        name: 'get_weather',
        description: 'look up',
        parameters: { type: 'object', properties: { city: { type: 'string' } } },
      },
    },
  ]);
});

test('payload: 必备骨架字段齐全', () => {
  const payload = buildChatPayload(ANTHROPIC_BODY, MODEL_CONFIG, { userID: 'u-1', ...INJECT });
  assert.equal(payload.stream, true);
  assert.equal(payload.chat_task, 'FREE_INPUT');
  assert.equal(payload.session_type, 'qodercli');
  assert.equal(payload.agent_id, 'agent_common');
  assert.equal(payload.task_id, 'common');
  assert.equal(payload.version, '3');
  assert.equal(payload.source, 1);
  assert.deepEqual(payload.business, {
    product: 'cli', version: '1.0.0', type: 'agent', stage: 'start',
    id: FIXED_UUID, name: 'thanks', begin_at: FIXED_NOW,
  });
});

test('payload: 同输入同 userID 同 model → 同 record id；session_id 前缀稳定', () => {
  const a = buildChatPayload(ANTHROPIC_BODY, MODEL_CONFIG, { userID: 'u-1', ...INJECT });
  const b = buildChatPayload(ANTHROPIC_BODY, MODEL_CONFIG, { userID: 'u-1', ...INJECT });
  assert.equal(a.chat_record_id, b.chat_record_id);
  assert.equal(a.request_set_id, b.request_set_id);
  assert.equal(a.chat_record_id, stableChatRecordID('qmodel_latest', a.messages, a.tools, 100));
  const prefix = stableHash('qoder-session', 'u-1', 'qmodel_latest');
  assert.ok(a.session_id.startsWith(`${prefix}-`), `session_id 应以 ${prefix}- 开头`);
  const other = buildChatPayload(ANTHROPIC_BODY, MODEL_CONFIG, { userID: 'u-2', ...INJECT });
  assert.notEqual(other.session_id.slice(0, 16), prefix, '不同 userID → 不同 session 前缀');
  // record id 只由 model+messages+tools+maxTokens 决定（源码如此，不含 userID）
  assert.equal(a.chat_record_id, other.chat_record_id);
});

test('payload: 未知模型（无 key）抛错', () => {
  assert.throws(() => buildChatPayload(ANTHROPIC_BODY, null, { userID: 'u-1' }), /Unknown Qoder model/);
});
