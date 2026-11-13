/**
 * Anthropic 事件序列 → 完整 message JSON（供非流式出站 / sendCollect）。
 * 四池（qoder/trae/workbuddy/codearts）共用：此前为池内四份同构拷贝，已按 03 §5 上提；
 * 池间唯一合法差异（兜底 message id）经 `fallbackId` 参数表达。
 */

export function anthropicMessageFromEvents(events, { fallbackId = 'msg_gateway' } = {}) {
  let message = null;
  const blocks = [];
  let stopReason = null;
  let usage = { input_tokens: 0, output_tokens: 0 };
  for (const ev of events) {
    if (ev.type === 'message_start') {
      message = ev.message;
    } else if (ev.type === 'content_block_start') {
      blocks[ev.index] = { ...ev.content_block, __parts: [] };
    } else if (ev.type === 'content_block_delta') {
      const block = blocks[ev.index];
      if (!block) continue;
      if (ev.delta?.type === 'text_delta') block.__parts.push(ev.delta.text ?? '');
      else if (ev.delta?.type === 'thinking_delta') block.__parts.push(ev.delta.thinking ?? '');
      else if (ev.delta?.type === 'input_json_delta') block.__parts.push(ev.delta.partial_json ?? '');
    } else if (ev.type === 'message_delta') {
      stopReason = ev.delta?.stop_reason ?? stopReason;
      usage = { ...usage, ...(ev.usage ?? {}) };
    }
  }
  const base = message ?? {
    id: fallbackId,
    type: 'message',
    role: 'assistant',
    model: 'unknown',
    content: [],
    stop_reason: null,
    stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0 },
  };
  const content = blocks.filter(Boolean).map((b) => {
    const text = b.__parts.join('');
    if (b.type === 'tool_use') {
      let input = {};
      try {
        input = text ? JSON.parse(text) : {};
      } catch {
        input = {};
      }
      return { type: 'tool_use', id: b.id, name: b.name, input };
    }
    if (b.type === 'thinking') return { type: 'thinking', thinking: text };
    return { type: 'text', text };
  });
  return { ...base, content, stop_reason: stopReason ?? base.stop_reason, usage: { input_tokens: usage.input_tokens, output_tokens: usage.output_tokens } };
}
