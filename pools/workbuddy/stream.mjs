// 上游是标准 OpenAI Chat Completions SSE（wheel stream_chat :487-503 按 data: 行解析），
// 事件转换直接复用 M2 的 openaiSseToAnthropicEvents。本文件只处理 WB 特有部分：
// HTTP 200 信封里的业务错误（AGENTS.md 已知坑——不能只看状态码）与流中断出口。

import { Readable } from 'node:stream';
import { createSseParser } from '../../adapters/sse-reader.mjs';
import { openaiSseToAnthropicEvents } from '../../adapters/anthropic-to-openai.mjs';

/** {"code":6004,"msg":"..."} / {"error":{...}} 形状且没有 choices → 业务错误。 */
export function businessErrorOf(json) {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return null;
  if (Array.isArray(json.choices) || json.usage) return null;
  if (typeof json.code === 'number' && typeof json.msg === 'string') {
    return { code: json.code, msg: json.msg };
  }
  if (json.error && typeof json.error === 'object') {
    return { code: json.code ?? json.error.code ?? 0, msg: String(json.error.message ?? json.error.msg ?? '') };
  }
  return null;
}

export class WbStreamError extends Error {
  constructor(biz) {
    super(biz.msg || `WB 上游业务错误 ${biz.code}`);
    this.name = 'WbStreamError';
    this.biz = biz;
  }
}

/**
 * 消费 WB 上游 SSE → Anthropic 事件数组（onEvents 逐批回调，流式直写用）。
 * data 是 {"code","msg"} 业务信封时抛 WbStreamError（流内外统一入口）。
 */
export async function consumeWbSse(upstream, { model, signal, onEvents }) {
  const parser = createSseParser();
  async function* eventStream() {
    if (!upstream.body) return;
    for await (const chunk of Readable.fromWeb(upstream.body, { signal })) {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      for (const { event, data } of parser.push(text)) {
        const biz = businessErrorOf(safeJson(data));
        if (biz) throw new WbStreamError(biz);
        yield { event, data };
      }
    }
    for (const { event, data } of parser.drain()) {
      const biz = businessErrorOf(safeJson(data));
      if (biz) throw new WbStreamError(biz);
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
