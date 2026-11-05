/**
 * 入站 Anthropic Messages → 上游 OpenAI Chat Completions（Qoder 池用，M4 接消费方）。
 * 流式方向的 openaiSseToAnthropicEvents 在本文件底部。
 */

function textOfContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((b) => (typeof b === 'string' ? b : b?.text ?? '')).join('');
  return '';
}

/** Anthropic Messages 请求体 → OpenAI Chat Completions 请求体（不含 model）。 */
export function messagesToChatCompletions(body) {
  const messages = [];

  const systemText =
    typeof body.system === 'string'
      ? body.system
      : Array.isArray(body.system)
        ? body.system.map((b) => (typeof b === 'string' ? b : b?.text ?? '')).join('')
        : '';
  if (systemText) messages.push({ role: 'system', content: systemText });

  for (const msg of body.messages ?? []) {
    const blocks = Array.isArray(msg.content) ? msg.content : null;

    if (msg.role === 'assistant') {
      const out = { role: 'assistant', content: null };
      if (blocks) {
        const text = blocks.filter((b) => b?.type === 'text').map((b) => b.text ?? '').join('');
        if (text) out.content = text;
        const calls = blocks
          .filter((b) => b?.type === 'tool_use')
          .map((b) => ({
            id: b.id,
            type: 'function',
            function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
          }));
        if (calls.length) out.tool_calls = calls;
      } else {
        out.content = msg.content ?? null;
      }
      messages.push(out);
      continue;
    }

    if (blocks) {
      const text = blocks.filter((b) => b?.type === 'text').map((b) => b.text ?? '').join('');
      if (text) messages.push({ role: 'user', content: text });
      for (const b of blocks) {
        if (b?.type !== 'tool_result') continue;
        messages.push({ role: 'tool', tool_call_id: b.tool_use_id, content: textOfContent(b.content) });
      }
      continue;
    }

    messages.push({ role: 'user', content: msg.content ?? '' });
  }

  const out = { messages };

  if (Array.isArray(body.tools) && body.tools.length) {
    out.tools = body.tools
      .filter((t) => t?.name)
      .map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.input_schema },
      }));
  }
  if (body.max_tokens != null) out.max_tokens = body.max_tokens;
  if (body.temperature != null) out.temperature = body.temperature;
  if (body.top_p != null) out.top_p = body.top_p;
  if (Array.isArray(body.stop_sequences) && body.stop_sequences.length) out.stop = body.stop_sequences;
  out.stream = body.stream === true;
  return out;
}

const FINISH_REASON = {
  stop: 'end_turn',
  tool_calls: 'tool_use',
  length: 'max_tokens',
};

/**
 * 消费 OpenAI chat.completion.chunk 的 SSE 事件流（sse-reader 产出），
 * 产出与真实 Anthropic SSE 形状一致的事件序列（generator，序列化由网关层做）。
 * tool 的 Anthropic 块 index 按首次到达顺序分配；所有块在流结束时统一 stop。
 */
export async function* openaiSseToAnthropicEvents(eventStream, model) {
  let started = false;
  let id = 'chatcmpl-gateway';
  let upstreamModel = model;
  let nextIndex = 0;
  let textIndex = -1; // 显式跟踪文本块 index；nextIndex 会被后续 tool 块消耗，不能再用 nextIndex-1 回指
  const toolBlockOf = new Map();
  let stopReason = 'end_turn';
  let usage = { input_tokens: 0, output_tokens: 0 };

  const startIndex = () => nextIndex++;

  for await (const { data } of eventStream) {
    if (data === '[DONE]') break;
    const c = (() => {
      try {
        return JSON.parse(data);
      } catch {
        return null;
      }
    })();
    if (!c) continue;

    if (!started) {
      started = true;
      id = c.id ?? id;
      upstreamModel = c.model ?? model;
      yield {
        type: 'message_start',
        message: {
          id,
          type: 'message',
          role: 'assistant',
          model: upstreamModel,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      };
    }

    for (const choice of c.choices ?? []) {
      const delta = choice.delta ?? {};
      if (typeof delta.content === 'string' && delta.content) {
        if (textIndex === -1) {
          textIndex = startIndex();
          yield { type: 'content_block_start', index: textIndex, content_block: { type: 'text', text: '' } };
        }
        yield { type: 'content_block_delta', index: textIndex, delta: { type: 'text_delta', text: delta.content } };
      }
      for (const tc of delta.tool_calls ?? []) {
        if (tc.index != null && !toolBlockOf.has(tc.index)) {
          if (textIndex !== -1) {
            yield { type: 'content_block_stop', index: textIndex };
            textIndex = -1;
          }
          toolBlockOf.set(tc.index, startIndex());
          yield {
            type: 'content_block_start',
            index: toolBlockOf.get(tc.index),
            content_block: { type: 'tool_use', id: tc.id, name: tc.function?.name, input: {} },
          };
        }
        const idx = toolBlockOf.get(tc.index);
        if (tc.function?.arguments) {
          yield { type: 'content_block_delta', index: idx, delta: { type: 'input_json_delta', partial_json: tc.function.arguments } };
        }
      }
      if (choice.finish_reason) stopReason = FINISH_REASON[choice.finish_reason] ?? 'end_turn';
    }

    if (c.usage) {
      usage = {
        input_tokens: c.usage.prompt_tokens ?? 0,
        output_tokens: c.usage.completion_tokens ?? 0,
      };
    }
  }

  if (!started) {
    yield {
      type: 'message_start',
      message: {
        id,
        type: 'message',
        role: 'assistant',
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    };
  }
  if (textIndex !== -1) yield { type: 'content_block_stop', index: textIndex };
  for (const idx of [...toolBlockOf.values()].sort((a, b) => a - b)) {
    yield { type: 'content_block_stop', index: idx };
  }
  yield { type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage };
  yield { type: 'message_stop' };
}
