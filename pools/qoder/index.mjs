import { Readable } from 'node:stream';
import { HttpError } from '../../http/errors.mjs';
import { createPoolScheduler, sessionKeyOf } from '../base.mjs';
import { createSseParser } from '../../adapters/sse-reader.mjs';
import { buildAuthHeaders } from './cosy.mjs';
import { qoderEncodeBody } from './encode.mjs';
import { chatUrl, regionConfig } from './region.mjs';
import { buildChatPayload } from './payload.mjs';
import { createQoderDecoder, QoderUpstreamError } from './stream.mjs';
import { createTokenManager } from './auth.mjs';
import { createQoderQuotaCache } from './quota.mjs';
import { createModelCatalog } from './models.mjs';
import { machineIdForAccount } from './identity.mjs';
import crypto from 'node:crypto';

/**
 * Qoder 池（cn + global）。协议：COSY 签名 + 私有编码体 + 双层 SSE（见 pools/qoder/*）。
 * send/sendCollect 契约与 zcode 池一致：出站是 Anthropic（/v1/messages 直连，
 * /v1/chat/completions 走 sendCollect 拿聚合后的 Anthropic JSON）。
 */

function safeParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** envelope.statusCodeValue（HTTP 200 里的业务信封）→ 分类。未知 code 按 server。 */
function envelopeClass(bodyText) {
  const env = safeParse(bodyText);
  const code = env?.statusCodeValue;
  if (typeof code === 'number' && code !== 200) {
    if (code === 401 || code === 403) {
      return { kind: 'auth', code, retryable: false, message: `Qoder 凭证失效（${code}）` };
    }
    if (code === 429) return { kind: 'rate_limit', code, retryable: true, message: 'Qoder 上游限流（429）' };
    return { kind: 'server', code, retryable: true, message: `Qoder 上游业务错误 ${code}: ${String(env?.body ?? '').slice(0, 200)}` };
  }
  return null;
}

/** 上游错误分类（与 zcode 池同名同形状导出）。 */
export function classifyUpstreamError(status, bodyText) {
  const env = envelopeClass(bodyText);
  if (env) return env;
  if (status === 429) return { kind: 'rate_limit', code: 429, retryable: true, message: 'Qoder 上游限流' };
  if (status === 401 || status === 403) {
    return { kind: 'auth', code: status, retryable: false, message: 'Qoder 凭证失效，需要重新登录' };
  }
  if (status >= 500) return { kind: 'server', code: status, retryable: true, message: `Qoder 上游错误 ${status}` };
  return { kind: 'client', code: status, retryable: false, message: `Qoder 上游拒绝了请求 ${status}` };
}

function errorFrom(cls, status) {
  const httpStatus = cls.kind === 'rate_limit' ? 429 : cls.kind === 'server' ? 502 : status;
  return new HttpError(httpStatus, cls.message, {
    type: cls.kind === 'rate_limit' ? 'rate_limit_error' : cls.kind === 'auth' ? 'authentication_error' : 'api_error',
  });
}

/** Anthropic 事件序列 → 完整 message JSON（供非流式出站 / sendCollect）。 */
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
    id: 'msg_qoder',
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

export function createQoderPool({
  accounts = [],
  config = {},
  fetchImpl = fetch,
  rng = Math.random,
  now = Date.now,
  region = 'global',
} = {}) {
  const mode = region;
  const regionCfg = regionConfig(mode);
  const name = regionCfg.providerID;
  const identitySeed = config.identitySeed || 'default';
  const upstreamTimeoutMs = config.upstreamTimeoutMs ?? 600_000;
  // 测试/部署可把上游指到桩：endpoints.{chat,modelList,auth,quota}
  const endpoints = config.endpoints || {};
  const quota = config.quota || createQoderQuotaCache({ mode, url: endpoints.quota, fetchImpl, now });

  const scheduler = createPoolScheduler({
    name,
    accounts: accounts.map((a) => ({
      ...a,
      machineID: a.machineID || machineIdForAccount(identitySeed, a.id || a.userID || 'anon'),
    })),
    settings: {
      ...(config.poolSettings || {}),
      ...(config.maxInFlight != null ? { maxInFlight: config.maxInFlight } : {}),
      ...(config.maxAttempts != null ? { maxAttempts: config.maxAttempts } : {}),
    },
    settingsFile: config.settingsFile,
    rng,
    now,
    quotaRatio: (acc) => (config.quota ?? quota).peek(acc),
  });

  const state = scheduler.accounts;
  const maxAttempts = Math.max(1, config.maxAttempts ?? scheduler.settings.maxAttempts);
  const tokens = createTokenManager({ mode, fetchImpl, now, url: endpoints.auth });
  const catalog = createModelCatalog({
    mode,
    cacheFile: config.modelsCacheFile || `${config.dataDir ?? '.'}/pools/${name}/models-cache.json`,
    fetchImpl,
    now,
    url: endpoints.modelList,
  });

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
    return new HttpError(429, `所有 Qoder 账号暂不可用，约 ${Math.max(1, Math.ceil(waitMs / 60_000))} 分钟后恢复${suffix}`, {
      type: 'rate_limit_error',
    });
  }

  function chatHeadersFor(acc, encodedBody, modelConfig, requestUrl) {
    if (!acc.userID) {
      throw new HttpError(500, `账号 ${acc.id} 缺少 userID，无法构造 COSY 头（重新导入：node tools/import-qoder.mjs）`, {
        type: 'api_error',
      });
    }
    return {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Accept-Encoding': 'identity',
      'X-Model-Key': modelConfig.key,
      'X-Model-Source': modelConfig.source || 'system',
      ...buildAuthHeaders(encodedBody, requestUrl, {
        userID: acc.userID,
        authToken: acc.jobToken,
        name: acc.name || '',
        email: acc.email || '',
        machineID: acc.machineID,
      }, { now }),
    };
  }

  /**
   * 取上游 SSE 并解码。返回 { events }；onEvents 分批回调（流式时逐批写客户端）。
   * QoderUpstreamError / HTTP 错误由 here 统一分类。
   */
  async function consumeSse(upstream, { model, signal, onEvents }) {
    const decoder = createQoderDecoder({ model });
    if (!upstream.body) {
      const finalEvents = decoder.end();
      onEvents?.(finalEvents);
      return finalEvents;
    }
    const parser = createSseParser();
    for await (const chunk of Readable.fromWeb(upstream.body, { signal })) {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      // 注意：只在流末尾 drain；逐块 drain 会把跨 chunk 截断的半行当完整行发出去
      for (const { data } of parser.push(text)) {
        const { done, events } = decoder.pushData(data);
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
    const modelConfig = catalog.configFor(upstreamModel);
    if (!modelConfig) {
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

      // token 过期 → 单飞刷新（PAT 重交换 / refresh_token）；patch（含过期时间）必须回写，
      // 否则过期后每个请求都重走一次交换
      const { token, patch } = await tokens.accessFor(acc);
      if (!token) {
        scheduler.onUpstreamError(acc, { kind: 'auth', code: 0, retryable: false, message: '无可用凭证' });
        lastError = new HttpError(502, `账号 ${acc.id} 缺少可用凭证`, { type: 'api_error' });
        continue;
      }
      if (patch) scheduler.updateAccount(acc.id, patch);
      acc.jobToken = token;

      // 额度感知调度：fire-and-forget 刷新候选账号额度（cache 内部有 5min TTL + 失败退避，
      // 幂等且不阻塞请求）；成功后 quotaRatio.peek 有值，下一轮权重即生效。
      if (config.quota) {
        config.quota.get(acc).catch(() => {});
      }

      const payload = buildChatPayload(body, modelConfig, { userID: acc.userID || 'qoder-user', now });
      const encoded = qoderEncodeBody(Buffer.from(JSON.stringify(payload)));
      const timeout = AbortSignal.timeout(upstreamTimeoutMs);
      const sig = signal ? AbortSignal.any([signal, timeout]) : timeout;
      acc.inFlight += 1;

      const requestUrl = endpoints.chat || chatUrl(mode);
      let upstream;
      try {
        upstream = await fetchImpl(requestUrl, {
          method: 'POST',
          headers: chatHeadersFor(acc, encoded, modelConfig, requestUrl),
          body: encoded,
          signal: sig,
        });
      } catch (err) {
        if (signal?.aborted) return;
        scheduler.onUpstreamError(acc, { kind: 'server', code: 0, retryable: true, message: err.message });
        lastError = timeout.aborted
          ? new HttpError(504, `Qoder 上游 ${upstreamTimeoutMs}ms 内无响应`, { type: 'api_error' })
          : new HttpError(502, `连接 Qoder 上游失败：${err.message}`, { type: 'api_error' });
        continue;
      } finally {
        acc.inFlight -= 1;
      }

      if (!upstream.ok) {
        const text = await upstream.text();
        const cls = classifyUpstreamError(upstream.status, text);
        scheduler.onUpstreamError(acc, cls);
        if (stickyKey) scheduler.stickyClear(stickyKey);
        if (!cls.retryable) throw errorFrom(cls, upstream.status);
        lastError = errorFrom(cls, upstream.status);
        continue;
      }

      // HTTP 200 + SSE。collect / 非流式：可以安全重试（客户端还没收到任何字节）。
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
        const cls = err instanceof QoderUpstreamError ? err.cls : null;
        if (streaming && wrote) {
          res.destroy(); // 已经给客户端写过字节，只能断开
          return;
        }
        scheduler.onUpstreamError(acc, cls ?? { kind: 'server', code: 0, retryable: true, message: err?.message || 'SSE 解码失败' });
        if (stickyKey) scheduler.stickyClear(stickyKey);
        if (cls && !cls.retryable) throw errorFrom(cls, upstream.status);
        lastError = cls ? errorFrom(cls, upstream.status) : new HttpError(502, `Qoder 上游流中断：${err?.message}`, { type: 'api_error' });
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

  /** 收集聚合后的 Anthropic message JSON（不写 res），供 /v1/chat/completions 协议转换。 */
  function sendCollect(args) {
    return dispatch({ ...args, collect: true });
  }

  return {
    name,
    type: 'pool',
    region: mode,
    accounts: state,
    scheduler,
    catalog,
    models: () =>
      catalog.models().map((m) => ({
        id: m.id,
        display_name: m.display_name || m.id,
        context_window: m.context_window ?? DEFAULT_CONTEXT_WINDOW,
        supports_tools: true,
        supports_thinking: !!m.is_reasoning,
        degraded: !!m.degraded,
      })),
    /** 用账号 token 刷新 model/list 缓存；失败静默（degraded）。 */
    async refreshModels() {
      const acc = state.find((a) => a.jobToken);
      if (!acc) return false;
      return catalog.refresh(acc, { userID: acc.userID });
    },
    send,
    sendCollect,
    quota,
  };
}

const DEFAULT_CONTEXT_WINDOW = 1e6;
