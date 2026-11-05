// SOLO 私有 SSE → Anthropic 事件流。
// 移植自 vendor/cpa-trae/trae/upstream/solosse.go（MIT）：ParseSOLOLine（:109-144）、
// soloPlanLimitCodes/soloModelMismatchCodes 与 Kind() 分类顺序（:59-106）、
// mergeToolCallJSON/mergeToolCallDelta（:268-333，function_call 字段名与
// namespace/partial_arguments 清理）、MsgIndicatesInputTooLarge（client.go:123-131 词表）。
//
// 产出形状对齐 pools/qoder/stream.mjs 的解码器：message_start 懒发（首个内容事件或收尾）、
// 任一时刻最多一个打开的内容块（开新块前先关旧块）、reasoning→thinking / response→text_delta /
// tool_calls→tool_use（arguments 逐片 input_json_delta）、token_usage 缓存到 message_delta。
// reasoning_tokens 丢弃不伪造（简报裁决）。

import { createSseParser } from '../../adapters/sse-reader.mjs';

const FINISH_REASON = { stop: 'end_turn', tool_calls: 'tool_use', length: 'max_tokens' };

// 流内业务码 → 套餐/配额耗尽（12h 冷却）：上游对「没有该模型配额」也发 4008，
// 与积分余额是两本账（solosse.go:59-65）。
const PLAN_LIMIT_CODES = new Set([1005, 4008]);
// 流内业务码 → 模型/通道不匹配（solosse.go:67-73）。
const MODEL_MISMATCH_CODES = new Set([4001]);

// client.go:104-117 inputTooLargeMarkers（大输入是请求级问题，不冷却账号）。
const INPUT_TOO_LARGE_MARKERS = [
  'too long',
  'too many tokens',
  'context length',
  'maximum context',
  'context window',
  'request entity too large',
  'input too large',
  '输入过长',
  '内容过长',
  '上下文过长',
  '上下文长度',
  '超出模型上限',
];

export function msgIndicatesInputTooLarge(s) {
  const lower = String(s ?? '').toLowerCase();
  return INPUT_TOO_LARGE_MARKERS.some((m) => lower.includes(m));
}

export class TraeStreamError extends Error {
  constructor(cls) {
    super(cls.message);
    this.name = 'TraeStreamError';
    this.cls = cls;
  }
}

/**
 * 流内 event:error 分类。顺序敏感（solosse.go:91-106 Kind()）：
 * 1005/4008 → quota_exhausted（12h 冷却+换号）；过大文案 → 请求级 400；
 * 4001（非过大）→ 请求级 400 不重试不冷却；其它 → client（可换号）。
 */
export function classifyTraeStreamError(code, msg) {
  const message = `Trae 上游流内错误 code=${code}: ${msg}`;
  if (PLAN_LIMIT_CODES.has(code)) {
    return { kind: 'quota_exhausted', code, retryable: true, httpStatus: 429, message };
  }
  // 过大文案判定在模型不匹配之前（"prompt is too long" 可能裹在 4001 里）
  if (msgIndicatesInputTooLarge(msg)) {
    return { kind: 'client', code, retryable: false, httpStatus: 400, inputTooLarge: true, message };
  }
  if (MODEL_MISMATCH_CODES.has(code)) {
    // 请求级失败：换任何账号结果相同，不冷却、不换号重试（solosse.go:67-73）
    return { kind: 'client', code, retryable: false, httpStatus: 400, inputTooLarge: false, message };
  }
  return { kind: 'client', code, retryable: true, httpStatus: 400, inputTooLarge: false, message };
}

/** 归一 output.tool_calls：null / 单对象 / 数组 → 数组（mergeToolCallJSON 的入口形状）。 */
function toolCallArray(raw) {
  if (raw == null) return [];
  const arr = Array.isArray(raw) ? raw : [raw];
  return arr.filter((c) => c && typeof c === 'object');
}

export function createTraeDecoder({ model } = {}) {
  let started = false;
  let nextIndex = 0;
  let openBlock = -1;
  let openType = null;
  let stopReason = 'end_turn';
  let usage = { input_tokens: 0, output_tokens: 0 };
  let finished = false;
  const events = [];
  // 上游 tool index → { blockIndex, seenArguments }（mergeToolCallDelta：id/name 直覆盖、arguments 拼接）
  const tools = new Map();

  const emit = (ev) => events.push(ev);

  function startIndex() {
    return nextIndex++;
  }

  function closeOpenBlock() {
    if (openBlock !== -1) {
      emit({ type: 'content_block_stop', index: openBlock });
      openBlock = -1;
      openType = null;
    }
  }

  function ensureMessageStart() {
    if (started) return;
    started = true;
    emit({
      type: 'message_start',
      message: {
        id: 'msg_trae',
        type: 'message',
        role: 'assistant',
        model: model ?? 'unknown',
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    });
  }

  /** 同类型连续 delta 复用已开块；不同类型先关旧块再开新块。 */
  function openBlockOfType(type, contentBlock) {
    if (openBlock !== -1 && openType === type) return openBlock;
    closeOpenBlock();
    const index = startIndex();
    openBlock = index;
    openType = type;
    emit({ type: 'content_block_start', index, content_block: contentBlock });
    return index;
  }

  function handleOutput(data) {
    const reasoning = typeof data.reasoning_content === 'string' ? data.reasoning_content : '';
    const response = typeof data.response === 'string' ? data.response : '';
    const calls = toolCallArray(data.tool_calls);
    if (!reasoning && !response && !calls.length) return;

    ensureMessageStart();
    if (reasoning) {
      const index = openBlockOfType('thinking', { type: 'thinking', thinking: '' });
      emit({ type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: reasoning } });
    }
    if (response) {
      const index = openBlockOfType('text', { type: 'text', text: '' });
      emit({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: response } });
    }
    for (let i = 0; i < calls.length; i++) {
      const call = calls[i];
      // SOLO 上游条目用 function_call 字段，function 也兼容（mergeToolCallDelta）
      const fn = call.function_call ?? call.function;
      if (!fn && call.id == null) continue;
      const upIndex = typeof call.index === 'number' ? call.index : i;
      let state = tools.get(upIndex);
      if (!state) {
        closeOpenBlock();
        const blockIndex = startIndex();
        state = { blockIndex, id: typeof call.id === 'string' && call.id ? call.id : `toolu_trae_${upIndex}` };
        tools.set(upIndex, state);
        emit({
          type: 'content_block_start',
          index: blockIndex,
          content_block: { type: 'tool_use', id: state.id, name: fn?.name ?? '', input: {} },
        });
        openBlock = blockIndex;
        openType = 'tool_use';
      }
      if (typeof fn?.arguments === 'string' && fn.arguments) {
        emit({ type: 'content_block_delta', index: state.blockIndex, delta: { type: 'input_json_delta', partial_json: fn.arguments } });
      }
    }
  }

  function finish() {
    if (finished) return;
    finished = true;
    ensureMessageStart();
    closeOpenBlock();
    emit({ type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage });
    emit({ type: 'message_stop' });
  }

  function pushEvent(eventName, dataStr) {
    const event = String(eventName ?? 'message');
    let data = null;
    if (dataStr) {
      try {
        data = JSON.parse(dataStr);
      } catch {
        return { done: finished, events: [] };
      }
      if (!data || typeof data !== 'object') data = null;
    }
    switch (event) {
      case 'output':
        if (data) handleOutput(data);
        break;
      case 'token_usage':
        if (data) {
          usage = {
            input_tokens: typeof data.prompt_tokens === 'number' ? data.prompt_tokens : 0,
            output_tokens: typeof data.completion_tokens === 'number' ? data.completion_tokens : 0,
          };
        }
        break;
      case 'done':
        if (data && typeof data.finish_reason === 'string' && FINISH_REASON[data.finish_reason]) {
          stopReason = FINISH_REASON[data.finish_reason];
        }
        finish();
        break;
      case 'error': {
        const code = typeof data?.code === 'number' ? data.code : 0;
        const cls = classifyTraeStreamError(code, typeof data?.message === 'string' ? data.message : '');
        throw new TraeStreamError(cls);
      }
      default:
        break; // metadata / timing_cost / extra_info / id: 行：内容不进 Anthropic 流
    }
    return { done: finished, events: events.splice(0) };
  }

  function end() {
    if (finished) return [];
    finish();
    return events.splice(0);
  }

  return { pushEvent, end };
}

/** 便捷：把 SSE 文本（完整或增量）喂给解析器 + 解码器，收集事件。 */
export function feedTraeSse(decoder, text, parser = createSseParser()) {
  const out = [];
  let done = false;
  for (const { event, data } of parser.push(text)) {
    const r = decoder.pushEvent(event, data);
    out.push(...r.events);
    if (r.done) done = true;
  }
  return { events: out, done, parser };
}
