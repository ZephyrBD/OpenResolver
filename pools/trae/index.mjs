// Trae 池（SOLO CN，native 直连）。契约与 pools/qoder/index.mjs 同形：send /
// sendCollect 共用 dispatch，classifyUpstreamError 同名同形状导出，401 → auth
//（base 标 needs_login），流内 1005/4008 → quota_exhausted（base 内建 12h 冷却），
// 4001 / "prompt is too long" → 请求级 400：不冷却账号、不换号重试（换任何账号
// 结果相同，vendor/cpa-trae issue #9 的处理）。
//
// Anthropic 事件 → message JSON 的聚合抄自 pools/qoder/index.mjs
// anthropicMessageFromEvents（不 import 池实现，简报约束）。

import path from 'node:path';
import { Readable } from 'node:stream';
import { HttpError } from '../../http/errors.mjs';
import { createPoolScheduler, sessionKeyOf } from '../base.mjs';
import { createSseParser } from '../../adapters/sse-reader.mjs';
import { loadAccounts, saveAccounts } from '../zcode/accounts.mjs';
import { DEFAULT_CHAT_HOST, DEFAULT_API_HOST, EP_EXCHANGE } from './constants.mjs';
import { soloHeaders } from './headers.mjs';
import { buildTraePayload } from './payload.mjs';
import { createTraeDecoder, TraeStreamError } from './stream.mjs';
import { createTokenManager } from './auth.mjs';
import { createTraeQuotaCache } from './quota.mjs';
import { createTraeModelCatalog } from './models.mjs';

/** HTTP 层错误分类（流内 event:error 的分类在 stream.mjs classifyTraeStreamError）。 */
export function classifyUpstreamError(status, bodyText) {
  let code = null;
  try {
    const json = JSON.parse(bodyText);
    code = typeof json?.code === 'number' ? json.code : null;
  } catch {
    // 非 JSON 体按 HTTP 状态分类
  }
  // 上游可能在 HTTP 200 里带业务错误（AGENTS.md 已知坑），流外同理按 code 先判
  if (code === 1005 || code === 4008) {
    return { kind: 'quota_exhausted', code, retryable: true, message: `Trae 套餐额度耗尽（${code}）` };
  }
  if (code === 4001) {
    return { kind: 'client', code, retryable: false, httpStatus: 400, message: `Trae 上游拒绝：模型/通道不匹配（${code}）` };
  }
  if (status === 429) return { kind: 'rate_limit', code: 429, retryable: true, message: 'Trae 上游限流' };
  if (status === 401 || status === 403) {
    return { kind: 'auth', code: status, retryable: false, message: 'Trae 凭证失效，需要重新登录' };
  }
  if (status >= 500) return { kind: 'server', code: status, retryable: true, message: `Trae 上游错误 ${status}` };
  return { kind: 'client', code: code ?? status, retryable: false, message: `Trae 上游拒绝了请求 ${status}` };
}

function errorFrom(cls, status) {
  const httpStatus = cls.httpStatus ?? (cls.kind === 'rate_limit' ? 429 : cls.kind === 'server' ? 502 : status || 502);
  return new HttpError(httpStatus, cls.message, {
    type:
      cls.kind === 'rate_limit' || cls.kind === 'quota_exhausted'
        ? 'rate_limit_error'
        : cls.kind === 'auth'
          ? 'authentication_error'
          : cls.kind === 'client'
            ? 'invalid_request_error'
            : 'api_error',
  });
}

/** Anthropic 事件序列 → 完整 message JSON（非流式出站 / sendCollect 用）。 */
export function anthropicMessageFromEvents(events) {
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
    id: 'msg_trae',
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

export function createTraePool({
  accounts = [],
  config = {},
  fetchImpl = fetch,
  rng = Math.random,
  now = Date.now,
} = {}) {
  const name = 'trae';
  const upstreamTimeoutMs = config.upstreamTimeoutMs ?? 600_000;
  const endpoints = config.endpoints || {};
  const chatUrl = endpoints.chat || `${config.chatHost || DEFAULT_CHAT_HOST}/api/agent/v3/llm_utils_chat`;
  const catalog = createTraeModelCatalog();
  const accountsFile = config.accountsFile || null;
  const quota = config.quota || createTraeQuotaCache({ bizHost: config.bizHost, usageUrl: endpoints.quota, checkinUrl: endpoints.checkin, fetchImpl, now });

  const scheduler = createPoolScheduler({
    name,
    accounts,
    settings: {
      ...(config.poolSettings || {}),
      ...(config.maxInFlight != null ? { maxInFlight: config.maxInFlight } : {}),
      ...(config.maxAttempts != null ? { maxAttempts: config.maxAttempts } : {}),
    },
    settingsFile: config.settingsFile,
    rng,
    now,
    quotaRatio: (acc) => quota.peek(acc),
  });

  const state = scheduler.accounts;
  const maxAttempts = Math.max(1, config.maxAttempts ?? scheduler.settings.maxAttempts);
  const tokens = createTokenManager({
    fetchImpl,
    now,
    url: endpoints.auth || `${config.apiHost || DEFAULT_API_HOST}${EP_EXCHANGE}`,
  });

  /** refreshToken 轮换立即落盘（vendor client.go:366-367：旧 rt 换发即作废，重启丢盘 = 死号）。 */
  function persistTokenPatch(accId, patch) {
    if (!accountsFile) return;
    try {
      const dir = path.dirname(accountsFile);
      const list = loadAccounts(dir);
      const row = list.find((a) => a.id === accId);
      if (!row) return;
      Object.assign(row, patch);
      saveAccounts(dir, list);
    } catch (err) {
      console.error(`[trae] token patch 落盘失败（${accId}）：${err?.message}`);
    }
  }

  /** 流已开头后只能以 Anthropic error 事件收尾（不裸 destroy，客户端至少拿到可解析错误）。 */
  function writeAnthropicError(res, err) {
    res.write(`event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: err.type, message: err.message } })}\n\n`);
  }

  function unavailable(cause) {
    const info = scheduler.unavailableInfo();
    if (!info.pool) {
      return new HttpError(429, '没有可用账号，请检查账号状态', { type: 'rate_limit_error' });
    }
    if (!info.cooling && info.saturated) {
      return new HttpError(429, '当前并发已满，请稍后重试', { type: 'rate_limit_error' });
    }
    const waitMs = Math.max(0, (info.soonestRecovery || scheduler.soonestRecovery()) - scheduler.now());
    const suffix = cause ? `（最后错误：${cause}）` : '';
    return new HttpError(429, `所有 Trae 账号暂不可用，约 ${Math.max(1, Math.ceil(waitMs / 60_000))} 分钟后恢复${suffix}`, {
      type: 'rate_limit_error',
    });
  }

  async function consumeSse(upstream, { model, signal, onEvents }) {
    const decoder = createTraeDecoder({ model });
    if (!upstream.body) {
      const finalEvents = decoder.end();
      onEvents?.(finalEvents);
      return finalEvents;
    }
    const parser = createSseParser();
    for await (const chunk of Readable.fromWeb(upstream.body, { signal })) {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      // 只在流末尾 drain：跨 chunk 半行不是完整事件（qoder 池同款教训）
      for (const { event, data } of parser.push(text)) {
        const { done, events } = decoder.pushEvent(event, data);
        if (events.length) onEvents?.(events);
        if (done) {
          const finalEvents = decoder.end();
          onEvents?.(finalEvents);
          return finalEvents;
        }
      }
    }
    const finalEvents = decoder.end();
    onEvents?.(finalEvents);
    return finalEvents;
  }

  async function dispatch({ req, res, body, key, signal, collect }) {
    let lastError = null;
    const tried = new Set();
    const stickyKey = sessionKeyOf({ req, body, keyId: key?.id });
    const upstreamModel = body.model;
    if (!catalog.configFor(upstreamModel)) {
      throw new HttpError(400, `未知模型 "${upstreamModel}"`, { type: 'invalid_request_error' });
    }

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      let acc = null;
      if (stickyKey) {
        if (attempt === 0) {
          const bound = scheduler.stickyGet(stickyKey, { readyOnly: true });
          if (bound && !tried.has(bound.id)) acc = bound;
          else scheduler.stickyClear(stickyKey);
        } else {
          scheduler.stickyClear(stickyKey);
        }
      }
      if (!acc) acc = scheduler.pick({ exclude: tried, allowFallback: attempt > 0 });
      if (!acc) throw unavailable(lastError?.message);
      tried.add(acc.id);

      const { token, patch } = await tokens.accessFor(acc);
      if (!token) {
        scheduler.onUpstreamError(acc, { kind: 'auth', code: 0, retryable: false, message: '无可用凭证' });
        lastError = new HttpError(502, `账号 ${acc.id} 缺少可用凭证`, { type: 'api_error' });
        continue;
      }
      if (patch) {
        scheduler.updateAccount(acc.id, patch);
        persistTokenPatch(acc.id, patch);
      }
      acc.jwt = token;

      // 额度感知调度：fire-and-forget（cache 内部 5min TTL + 失败退避）
      quota
        .get(acc)
        .then((r) => {
          if (r.checkin) scheduler.updateAccount(acc.id, { checkin: r.checkin });
        })
        .catch(() => {});

      const payload = buildTraePayload(body, upstreamModel);
      const timeout = AbortSignal.timeout(upstreamTimeoutMs);
      const sig = signal ? AbortSignal.any([signal, timeout]) : timeout;
      acc.inFlight += 1;

      let upstream;
      try {
        upstream = await fetchImpl(chatUrl, {
          method: 'POST',
          headers: soloHeaders({ jwt: token, uid: acc.uid, machineId: acc.machineId, deviceId: acc.deviceId }, true),
          body: JSON.stringify(payload),
          signal: sig,
        });
      } catch (err) {
        if (signal?.aborted) return;
        scheduler.onUpstreamError(acc, { kind: 'server', code: 0, retryable: true, message: err.message });
        lastError = timeout.aborted
          ? new HttpError(504, `Trae 上游 ${upstreamTimeoutMs}ms 内无响应`, { type: 'api_error' })
          : new HttpError(502, `连接 Trae 上游失败：${err.message}`, { type: 'api_error' });
        continue;
      } finally {
        acc.inFlight -= 1;
      }

      if (!upstream.ok) {
        const text = await upstream.text();
        const cls = classifyUpstreamError(upstream.status, text);
        // 请求级失败（4001 等）：账号无责，不冷却、不重试换号
        if (cls.kind === 'client' && !cls.retryable) throw errorFrom(cls, upstream.status);
        scheduler.onUpstreamError(acc, cls);
        if (stickyKey) scheduler.stickyClear(stickyKey);
        if (!cls.retryable) throw errorFrom(cls, upstream.status);
        lastError = errorFrom(cls, upstream.status);
        continue;
      }

      // HTTP 200 + 私有 SSE（流内业务错误也在这里冒出）。collect / 非流式可安全重试。
      const streaming = !collect && body.stream === true;
      let wrote = false;
      const events = [];
      try {
        if (streaming) {
          res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
          wrote = true;
        }
        await consumeSse(upstream, {
          model: upstreamModel,
          signal,
          onEvents: (batch) => {
            events.push(...batch);
            if (streaming) {
              for (const ev of batch) {
                res.write(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`);
              }
            }
          },
        });
      } catch (err) {
        const cls = err instanceof TraeStreamError ? err.cls : null;
        if (cls && cls.kind === 'client' && !cls.retryable) {
          // 请求级（4001 / 输入过大）：不记失败、不冷却
          if (stickyKey) scheduler.stickyClear(stickyKey);
          if (streaming && wrote) {
            writeAnthropicError(res, errorFrom(cls, 400));
            res.end();
            return;
          }
          throw errorFrom(cls, 400);
        }
        // 流内错误先分类记账再决定客户端出口：1005/4008 也要走 onUpstreamError（12h 冷却），
        // 不能因流已开头就跳过惩罚（M5 评审 F2）
        scheduler.onUpstreamError(acc, cls ?? { kind: 'server', code: 0, retryable: true, message: err?.message || 'SSE 解码失败' });
        if (stickyKey) scheduler.stickyClear(stickyKey);
        if (streaming && wrote) {
          writeAnthropicError(res, cls ? errorFrom(cls, 400) : new HttpError(502, `Trae 上游流中断：${err?.message}`, { type: 'api_error' }));
          res.end();
          return;
        }
        lastError = cls ? errorFrom(cls, 400) : new HttpError(502, `Trae 上游流中断：${err?.message}`, { type: 'api_error' });
        continue;
      }

      scheduler.onSuccess(acc);
      if (stickyKey) scheduler.stickySet(stickyKey, acc);

      if (streaming) {
        res.end();
        return;
      }
      const messageJson = anthropicMessageFromEvents(events);
      const bodyText = JSON.stringify(messageJson);
      if (collect) return { status: 200, contentType: 'application/json', bodyText };
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(bodyText);
      return;
    }

    if (signal?.aborted) return;
    throw lastError ?? unavailable();
  }

  function send(args) {
    return dispatch({ ...args, collect: false });
  }

  function sendCollect(args) {
    return dispatch({ ...args, collect: true });
  }

  return {
    name,
    type: 'pool',
    accounts: state,
    scheduler,
    catalog,
    models: () =>
      catalog.models().map((m) => ({
        id: m.id,
        display_name: m.display_name || m.id,
        upstream_model: m.id,
        context_window: m.context_window ?? null,
        max_tokens: m.max_tokens ?? null,
        supports_tools: m.supports_tools !== false,
        supports_thinking: m.supports_thinking !== false,
        ...(m.verified !== undefined ? { verified: m.verified } : {}),
      })),
    refreshModels: async () => true, // 静态表无上游刷新
    quota,
    send,
    sendCollect,
  };
}
