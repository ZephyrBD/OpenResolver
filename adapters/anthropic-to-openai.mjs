/**
 * 入站 Anthropic Messages → 上游 OpenAI Chat Completions（Qoder 池用，M4 接消费方）。
 * 流式方向的 openaiSseToAnthropicEvents 在本文件底部。
 */

function textOfContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((b) => (typeof b === 'string' ? b : b?.text ?? '')).join('');
  return '';
}

/** Anthropic Messages 请求体 → OpenAI Chat Completions 请求体（不含 model）。
 * 尾部做 tool 配对修复（WB 上游对 tool_calls 与 role:tool 不配对直接 400）：
 * - role:tool 必须紧跟带 tool_calls 的 assistant 消息，同轮文本垫后；
 * - 没等到结果的 tool_call 合成占位结果；配不到调用的孤儿结果丢弃；
 * - 缺 id 的 tool_use 合成 id，缺 tool_use_id 的结果按顺序认领最早的未闭合调用。 */
export function messagesToChatCompletions(body) {
  const messages = [];
  let synthN = 0;
  const synthId = () => `toolu_gw_${++synthN}`;
  const openCalls = []; // 尚未收到结果的 tool_call id（FIFO，须在下一条 assistant 前闭合）

  const flushOpenCalls = () => {
    while (openCalls.length) {
      messages.push({ role: 'tool', tool_call_id: openCalls.shift(), content: '[tool call aborted - no result]' });
    }
  };

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
      flushOpenCalls();
      const out = { role: 'assistant', content: null };
      if (blocks) {
        const text = blocks.filter((b) => b?.type === 'text').map((b) => b.text ?? '').join('');
        if (text) out.content = text;
        const calls = blocks
          .filter((b) => b?.type === 'tool_use')
          .map((b) => ({
            id: b.id || synthId(),
            type: 'function',
            function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
          }));
        if (calls.length) {
          out.tool_calls = calls;
          openCalls.push(...calls.map((c) => c.id));
        }
      } else {
        out.content = msg.content ?? null;
      }
      messages.push(out);
      continue;
    }

    if (blocks) {
      const texts = [];
      for (const b of blocks) {
        if (b?.type !== 'tool_result') {
          if (typeof b === 'string') texts.push(b);
          else if (b?.type === 'text') texts.push(b.text ?? '');
          continue;
        }
        let id = b.tool_use_id;
        if (id) {
          const at = openCalls.indexOf(id);
          if (at === -1) continue; // 孤儿结果：上游会判不配对，丢弃
          openCalls.splice(at, 1);
        } else {
          id = openCalls.shift();
          if (!id) continue;
        }
        messages.push({ role: 'tool', tool_call_id: id, content: textOfContent(b.content) });
      }
      flushOpenCalls();
      const text = texts.join('');
      if (text) messages.push({ role: 'user', content: text });
      continue;
    }

    flushOpenCalls();
    messages.push({ role: 'user', content: msg.content ?? '' });
  }
  flushOpenCalls();

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
  let synthIdN = 0; // 上游 delta 缺 id 时合成的 Anthropic tool_use id 计数
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
        // WB 上游偶发缺 index/id 的 tool_call delta：index 缺失时按 id 聚块，
        // 两者都缺时并入最近的自动块；Anthropic 块 index 按首次到达顺序分配。
        const key = tc.index != null ? `#${tc.index}` : tc.id ? `id:${tc.id}` : '@auto';
        if (!toolBlockOf.has(key)) {
          if (textIndex !== -1) {
            yield { type: 'content_block_stop', index: textIndex };
            textIndex = -1;
          }
          toolBlockOf.set(key, startIndex());
          if (key !== '@auto') toolBlockOf.delete('@auto');
          yield {
            type: 'content_block_start',
            index: toolBlockOf.get(key),
            content_block: { type: 'tool_use', id: tc.id || `toolu_gw_${++synthIdN}`, name: tc.function?.name ?? '', input: {} },
          };
        }
        const idx = toolBlockOf.get(key);
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
