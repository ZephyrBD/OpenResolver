// 移植自 qodbuddy2pi/assets/vendor/pi-provider-qoder/dist/index.js :1301-1503（thinking 剥离）、
// :1883-2031（双层 SSE 主循环）（MIT）。
//
// 外层 SSE：data: <envelope JSON>；envelope.statusCodeValue !== 200 → 上游错误；
// envelope.body === "[DONE]" → 结束；envelope.body 是 OpenAI chunk JSON 字符串。
// 内层 chunk 流由本模块自己产出 Anthropic 事件（reasoning_content / emittedStart 工具
// 语义与标准 OpenAI 流不同，不复用 openaiSseToAnthropicEvents），事件对象形状与
// adapters/anthropic-to-openai.mjs 的产出对齐，网关统一序列化。
//
// 与源码的两处偏差（报告已注明）：
// 1. ThinkingTagParser 在文本块之后又出现 <think> 时，源码把 thinking 块 splice 到文本前；
//    事件流的 index 已发出无法回改，这里改为追加新块。
// 2. 任一时刻最多一个打开的内容块（开新块前先关旧块），产出严格合法的 Anthropic SSE。

import { stripThinkingTags, stripDsmlResidue } from './thinking.mjs';

export class QoderUpstreamError extends Error {
  constructor(cls) {
    super(cls.message);
    this.name = 'QoderUpstreamError';
    this.cls = cls;
  }
}

/** envelope.statusCodeValue → 与 classifyUpstreamError 同形状的分类。未知业务 code 按 server。 */
export function classifyEnvelope(statusCodeValue, body) {
  const code = statusCodeValue;
  if (code === 401 || code === 403) {
    return { kind: 'auth', code, retryable: false, message: `Qoder 凭证失效（${code}）` };
  }
  if (code === 429) {
    return { kind: 'rate_limit', code, retryable: true, message: 'Qoder 上游限流（429）' };
  }
  return { kind: 'server', code, retryable: true, message: `Qoder 上游业务错误 ${code}: ${String(body ?? '').slice(0, 200)}` };
}

const FINISH_REASON = { stop: 'end_turn', tool_calls: 'tool_use', length: 'max_tokens' };

/**
 * 创建双层 SSE 解码器。
 * pushData(dataStr) → { done, events }；end() → 收尾事件（message_delta / message_stop）。
 */
export function createQoderDecoder({ model }) {
  let started = false;
  let messageId = 'msg_qoder';
  let upstreamModel = model;
  let nextIndex = 0;
  let openBlock = -1; // 任一时刻最多一个打开块
  let openBlockType = null;
  let stopReason = 'end_turn';
  let sawToolCall = false;
  let usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  const toolCallsState = [];
  const events = [];

  function emit(ev) {
    events.push(ev);
  }

  function startIndex() {
    return nextIndex++;
  }

  function closeOpenBlock() {
    if (openBlock !== -1) {
      emit({ type: 'content_block_stop', index: openBlock });
      openBlock = -1;
      openBlockType = null;
    }
  }

  /** 同类型的连续 delta 复用已开块；不同类型先关旧块再开新块。 */
  function openBlockOfType(contentBlock) {
    if (openBlock !== -1 && openBlockType === contentBlock.type) return openBlock;
    closeOpenBlock();
    const index = startIndex();
    openBlock = index;
    openBlockType = contentBlock.type;
    emit({ type: 'content_block_start', index, content_block: contentBlock });
    return index;
  }

  function ensureStarted(id, mdl) {
    if (started) return;
    started = true;
    if (id) messageId = id;
    if (mdl) upstreamModel = mdl;
    emit({
      type: 'message_start',
      message: {
        id: messageId,
        type: 'message',
        role: 'assistant',
        model: upstreamModel,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    });
  }

  // ---- ThinkingTagParser（源 :1342-1503），emitText/emitThinking 换成 Anthropic 事件 ----
  const THINKING_TAG_VARIANTS = [
    { open: '<thinking>', close: '</thinking>' },
    { open: '<think>', close: '</think>' },
    { open: '<reasoning>', close: '</reasoning>' },
    { open: '<thought>', close: '</thought>' },
  ];
  const ALL_THINKING_TAGS = THINKING_TAG_VARIANTS.flatMap((v) => [v.open, v.close]);

  function trailingPossibleTagPrefixLength(text, tag) {
    const max = Math.min(text.length, tag.length - 1);
    for (let len = max; len > 0; len--) {
      if (text.endsWith(tag.slice(0, len))) return len;
    }
    return 0;
  }

  function maxTrailingTagPrefixLength(text, tags) {
    let maxLen = 0;
    for (const tag of tags) maxLen = Math.max(maxLen, trailingPossibleTagPrefixLength(text, tag));
    return maxLen;
  }

  let textBuffer = '';
  let inThinking = false;
  let thinkingExtracted = false;
  let activeEndTag = THINKING_TAG_VARIANTS[0].close;

  function emitText(text) {
    if (!text) return;
    const index = openBlockOfType({ type: 'text', text: '' });
    emit({ type: 'content_block_delta', index, delta: { type: 'text_delta', text } });
  }

  function emitThinking(thinking) {
    if (!thinking) return;
    const index = openBlockOfType({ type: 'thinking', thinking: '' });
    emit({ type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking } });
  }

  function processBeforeThinking() {
    let bestOpenPos = -1;
    let bestOpenVariant = null;
    let bestClosePos = -1;
    let bestCloseVariant = null;
    for (const variant of THINKING_TAG_VARIANTS) {
      const openPos = textBuffer.indexOf(variant.open);
      if (openPos !== -1 && (bestOpenPos === -1 || openPos < bestOpenPos)) {
        bestOpenPos = openPos;
        bestOpenVariant = variant;
      }
      const closePos = textBuffer.indexOf(variant.close);
      if (closePos !== -1 && (bestClosePos === -1 || closePos < bestClosePos)) {
        bestClosePos = closePos;
        bestCloseVariant = variant;
      }
    }
    if (bestOpenVariant !== null && (bestCloseVariant === null || bestOpenPos < bestClosePos)) {
      if (bestOpenPos > 0) emitText(textBuffer.slice(0, bestOpenPos));
      textBuffer = textBuffer.slice(bestOpenPos + bestOpenVariant.open.length);
      activeEndTag = bestOpenVariant.close;
      inThinking = true;
      return;
    }
    if (bestCloseVariant !== null) {
      if (bestClosePos > 0) emitText(textBuffer.slice(0, bestClosePos));
      textBuffer = textBuffer.slice(bestClosePos + bestCloseVariant.close.length);
      if (textBuffer.startsWith('\n\n')) textBuffer = textBuffer.slice(2);
      else if (textBuffer.startsWith('\n')) textBuffer = textBuffer.slice(1);
      return;
    }
    const trailingPrefixLength = maxTrailingTagPrefixLength(textBuffer, ALL_THINKING_TAGS);
    const safeLen = textBuffer.length - trailingPrefixLength;
    if (safeLen > 0) {
      emitText(textBuffer.slice(0, safeLen));
      textBuffer = textBuffer.slice(safeLen);
    }
  }

  function processInsideThinking() {
    const endPos = textBuffer.indexOf(activeEndTag);
    if (endPos !== -1) {
      if (endPos > 0) emitThinking(textBuffer.slice(0, endPos));
      textBuffer = textBuffer.slice(endPos + activeEndTag.length);
      inThinking = false;
      thinkingExtracted = true;
      if (textBuffer.startsWith('\n\n')) textBuffer = textBuffer.slice(2);
      return;
    }
    const trailingPrefixLength = trailingPossibleTagPrefixLength(textBuffer, activeEndTag);
    const safeLen = textBuffer.length - trailingPrefixLength;
    if (safeLen > 0) {
      emitThinking(textBuffer.slice(0, safeLen));
      textBuffer = textBuffer.slice(safeLen);
    }
  }

  function processThinkingChunk(chunk) {
    textBuffer += chunk;
    while (textBuffer.length > 0) {
      const prevLength = textBuffer.length;
      if (!inThinking && !thinkingExtracted) {
        processBeforeThinking();
        if (textBuffer.length === 0) break;
      }
      if (inThinking) {
        processInsideThinking();
        if (textBuffer.length === 0) break;
      }
      if (thinkingExtracted) {
        emitText(textBuffer);
        textBuffer = '';
        break;
      }
      if (textBuffer.length >= prevLength) break;
    }
  }

  function finalizeThinking() {
    if (textBuffer.length === 0) return;
    if (inThinking) emitThinking(textBuffer);
    else emitText(textBuffer);
    textBuffer = '';
  }
  // ---- ThinkingTagParser 结束 ----

  function feedInner(inner) {
    ensureStarted(inner.id, inner.model);
    if (inner.usage) {
      const u = inner.usage;
      const promptTokens = u.prompt_tokens ?? 0;
      const cacheRead = u.prompt_tokens_details?.cached_tokens ?? 0;
      const cacheWrite = u.prompt_tokens_details?.cache_write_tokens ?? 0;
      usage = {
        input_tokens: Math.max(0, promptTokens - cacheRead - cacheWrite),
        output_tokens: u.completion_tokens ?? 0,
        cache_read_input_tokens: cacheRead,
        cache_creation_input_tokens: cacheWrite,
      };
    }
    const choice = inner.choices?.[0];
    const delta = choice?.delta;
    if (delta) {
      if (delta.reasoning_content) {
        const chunk = stripDsmlResidue(stripThinkingTags(delta.reasoning_content));
        if (chunk) emitThinking(chunk);
      }
      if (delta.content) {
        processThinkingChunk(delta.content);
      }
      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index ?? 0;
          if (!toolCallsState[idx]) toolCallsState[idx] = { arguments: '', id: '', name: '', blockIndex: -1, emittedStart: false };
          const state = toolCallsState[idx];
          if (tc.id) state.id = tc.id;
          if (tc.function?.name) state.name = tc.function.name;
          if (!state.emittedStart && (state.id || state.name)) {
            state.emittedStart = true;
            sawToolCall = true;
            state.blockIndex = openBlockOfType({ type: 'tool_use', id: state.id, name: state.name, input: {} });
            // 与源码对齐：arguments 先于 id/name 到达时已无条件累计进 state，
            // start 时补发已累计片段（保证事件流聚合出完整 arguments）
            if (state.arguments) {
              emit({ type: 'content_block_delta', index: state.blockIndex, delta: { type: 'input_json_delta', partial_json: state.arguments } });
            }
          }
          if (tc.function?.arguments) {
            state.arguments += tc.function.arguments;
            if (state.emittedStart && tc.function.arguments.length) {
              emit({ type: 'content_block_delta', index: state.blockIndex, delta: { type: 'input_json_delta', partial_json: tc.function.arguments } });
            }
          }
        }
      }
    }
    if (choice?.finish_reason) stopReason = FINISH_REASON[choice.finish_reason] ?? 'end_turn';
  }

  /**
   * 喂一行外层 SSE data。返回 { done, events }；坏 JSON 行跳过（与源码一致）。
   * envelope.statusCodeValue !== 200 时抛 QoderUpstreamError。
   */
  function pushData(dataStr) {
    if (dataStr === '[DONE]') return { done: true, events: [] };
    let envelope;
    try {
      envelope = JSON.parse(dataStr);
    } catch {
      return { done: false, events: [] }; // 坏 JSON 行：跳过继续
    }
    if (envelope && typeof envelope === 'object' && envelope.statusCodeValue !== undefined && envelope.statusCodeValue !== 200) {
      throw new QoderUpstreamError(classifyEnvelope(envelope.statusCodeValue, envelope.body));
    }
    const innerStr = envelope?.body;
    if (innerStr === '[DONE]') return { done: true, events: [] };
    if (!innerStr || typeof innerStr !== 'string') return { done: false, events: [] };
    let inner;
    try {
      inner = JSON.parse(innerStr);
    } catch {
      return { done: false, events: [] }; // 坏内层 JSON：跳过继续
    }
    const before = events.length;
    feedInner(inner);
    return { done: false, events: events.splice(0, events.length - before) };
  }

  /** 流结束：finalize thinking、关块、message_delta / message_stop。 */
  function end() {
    finalizeThinking();
    if (!started) ensureStarted(undefined, undefined);
    closeOpenBlock();
    if (sawToolCall) stopReason = 'tool_use';
    emit({
      type: 'message_delta',
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: {
        input_tokens: usage.input_tokens,
        output_tokens: usage.output_tokens,
        ...(usage.cache_read_input_tokens ? { cache_read_input_tokens: usage.cache_read_input_tokens } : {}),
        ...(usage.cache_creation_input_tokens ? { cache_creation_input_tokens: usage.cache_creation_input_tokens } : {}),
      },
    });
    emit({ type: 'message_stop' });
    return events.splice(0);
  }

  return { pushData, end };
}

export { stripThinkingTags, stripDsmlResidue };
