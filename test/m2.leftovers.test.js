import test from 'node:test';
import assert from 'node:assert/strict';
import { openaiSseToAnthropicEvents } from '../adapters/anthropic-to-openai.mjs';
import { chatCompletionsToMessages } from '../adapters/openai-to-anthropic.mjs';
import { HttpError } from '../http/errors.mjs';
import { startStub } from './helpers/stub.mjs';
import { createZcodePool } from '../pools/zcode/index.mjs';

async function collectEvents(chunks, model = 'GLM-5.3') {
  async function* source() {
    for (const c of chunks) yield { data: c };
  }
  const out = [];
  for await (const ev of openaiSseToAnthropicEvents(source(), model)) out.push(ev);
  return out;
}

// ① FINISH_REASON `length` 表项用例
test('openaiSseToAnthropicEvents: finish_reason "length" → stop_reason "max_tokens"', async () => {
  const events = await collectEvents([
    JSON.stringify({ id: 'c1', choices: [{ index: 0, delta: { content: 'partial output' }, finish_reason: null }] }),
    JSON.stringify({ id: 'c1', choices: [{ index: 0, delta: {}, finish_reason: 'length' }], usage: { prompt_tokens: 9, completion_tokens: 5 } }),
    '[DONE]',
  ]);
  const delta = events.find((e) => e.type === 'message_delta');
  assert.equal(delta.delta.stop_reason, 'max_tokens');
});

// ② 文本块 index 显式跟踪：文本 → 工具 → 再来文本，index 不得串块
test('openaiSseToAnthropicEvents: 工具块之后的新文本块拿到新 index，且 stop 配对正确', async () => {
  const events = await collectEvents([
    JSON.stringify({ id: 'c1', choices: [{ index: 0, delta: { content: 'before' }, finish_reason: null }] }),
    JSON.stringify({ id: 'c1', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 't1', function: { name: 'f', arguments: '{}' } }] }, finish_reason: null }] }),
    JSON.stringify({ id: 'c1', choices: [{ index: 0, delta: { content: 'after' }, finish_reason: 'stop' }] }),
    '[DONE]',
  ]);
  const starts = events.filter((e) => e.type === 'content_block_start');
  const deltas = events.filter((e) => e.type === 'content_block_delta');
  const stops = events.filter((e) => e.type === 'content_block_stop');

  assert.deepEqual(
    starts.map((e) => ({ index: e.index, type: e.content_block.type })),
    [
      { index: 0, type: 'text' },
      { index: 1, type: 'tool_use' },
      { index: 2, type: 'text' },
    ],
  );
  assert.deepEqual(
    deltas.map((e) => ({ index: e.index, type: e.delta.type, value: e.delta.text ?? e.delta.partial_json })),
    [
      { index: 0, type: 'text_delta', value: 'before' },
      { index: 1, type: 'input_json_delta', value: '{}' },
      { index: 2, type: 'text_delta', value: 'after' },
    ],
  );
  assert.deepEqual(
    stops.map((e) => e.index),
    [0, 2, 1],
    '文本块关闭后才能开工具块；收尾时剩余块统一 stop',
  );
});

// ③ collect 路径 200 业务信封：chat.completions 拿到 429（而非把错误当成功）
test('sendCollect 遇到 HTTP 200 业务信封（code 1005）→ chat.completions 返回 429 错误', async (t) => {
  const stub = await startStub(t, (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ code: 1005, msg: 'exceed quota limit' }));
  });
  const pool = createZcodePool({
    accounts: [{ id: 'z1', label: 'a1', jwt: 'jwt-1', uid: 'uid-1' }],
    profile: { system: [{ type: 'text', text: 'S' }], max_tokens: 128000 },
    config: { origin: stub.origin, maxAttempts: 1 },
  });

  await assert.rejects(
    pool.sendCollect({
      req: { headers: {} },
      res: {},
      body: { model: 'GLM-5.3', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] },
    }),
    (err) => err instanceof HttpError && err.status === 429 && /额度/.test(err.message),
  );
});

// ④ 数组 content 拒绝策略：text 部分放行；多模态部分 400 拒绝
test('chatCompletionsToMessages: content parts 数组——text 映射，image_url 等拒绝 400', () => {
  const ok = chatCompletionsToMessages({
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }, 'plain'] }],
  });
  assert.deepEqual(ok.messages, [{ role: 'user', content: [{ type: 'text', text: 'hi' }, { type: 'text', text: 'plain' }] }]);

  assert.throws(
    () =>
      chatCompletionsToMessages({
        messages: [{ role: 'user', content: [{ type: 'text', text: '看图' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,x' } }] }],
      }),
    (err) => err instanceof HttpError && err.status === 400 && err.type === 'invalid_request_error',
  );
});
