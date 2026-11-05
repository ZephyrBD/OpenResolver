// 上游是 OpenAI 兼容 Chat Completions SSE（client.go ChatStream :460-582），
// 事件转换直接复用 M2 的 openaiSseToAnthropicEvents（与 workbuddy/stream.mjs 同构）。
// 本文件只处理 CodeArts 特有部分：HTTP 200 内嵌错误（client.go preflightSSE :589-648）
// 与流中断出口。

import { Readable } from 'node:stream';
import { createSseParser } from '../../adapters/sse-reader.mjs';
import { openaiSseToAnthropicEvents } from '../../adapters/anthropic-to-openai.mjs';

/**
 * embeddedSseError（client.go:619-648）：data 帧带 error_code（非 "0"）→ 上游业务错误。
 * 状态分类：429/TPM/并发 → retryable 429；002002009/not registered/4004.200/
 * benefit not found/param invalid → 400 客户端问题；其余 → 502。
 */
export function embeddedSseStatus(errorCode, errorMsg = '') {
  const combined = `${errorCode} ${errorMsg}`.trim().toLowerCase();
  if (
    combined.includes('429') || combined.includes('tm.00001041') ||
    combined.includes('tpm') || combined.includes('并发会话')
  ) {
    return 429;
  }
  if (
    combined.includes('002002009') || combined.includes('not registered') ||
    combined.includes('4004.200') || combined.includes('benefit not found') ||
    combined.includes('inferhub.001001005') || combined.includes('request param is invalid') ||
    // TM.000010051：账号无权调用该模型（模型未开通/已下架，换模型而不是重试）
    combined.includes('tm.000010051') || combined.includes('无权调用该模型') ||
    combined.includes('未开通')
  ) {
    return 400;
  }
  return 502;
}

/** {"error_code":"..."} 且非 "0" → 业务错误；OpenAI chunk / [DONE] → null。 */
export function businessErrorOf(json) {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return null;
  const code = json.error_code;
  if (typeof code === 'string' && code && code !== '0') {
    return { code, msg: String(json.error_msg ?? '') };
  }
  return null;
}

export class CaStreamError extends Error {
  constructor(biz) {
    super(biz.msg || `CodeArts 上游业务错误 ${biz.code}`);
    this.name = 'CaStreamError';
    this.biz = biz;
  }
}

/**
 * 消费 CodeArts 上游 SSE → Anthropic 事件数组（onEvents 逐批回调，流式直写用）。
 * data 带 error_code 业务信封时抛 CaStreamError（流内外统一入口）。
 */
export async function consumeCaSse(upstream, { model, signal, onEvents }) {
  const parser = createSseParser();
  async function* eventStream() {
    if (!upstream.body) return;
    for await (const chunk of Readable.fromWeb(upstream.body, { signal })) {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      for (const { event, data } of parser.push(text)) {
        const biz = businessErrorOf(safeJson(data));
        if (biz) throw new CaStreamError(biz);
        yield { event, data };
      }
    }
    for (const { event, data } of parser.drain()) {
      const biz = businessErrorOf(safeJson(data));
      if (biz) throw new CaStreamError(biz);
      yield { event, data };
    }
  }

  const events = [];
  for await (const ev of openaiSseToAnthropicEvents(eventStream(), model)) {
    events.push(ev);
    onEvents?.([ev]);
  }
  return events;
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
