// WorkBuddy 原生池（cn + global，region 参数二相）。契约与 pools/trae/index.mjs 同形：
// send / sendCollect 共用 dispatch，classifyUpstreamError 同名同形状导出。
// 上游是标准 OpenAI Chat Completions（无 COSY/无签名，wheel stream_chat :449-482），
// 请求/响应转换复用 M2 adapters（adapters/anthropic-to-openai.mjs + adapters/sse-reader.mjs）。
//
// 错误分类（PROTOCOL.md §111-128 + 简报）：
// - 429 + 业务码 6004 → 模型级限流：{kind:'client', retryable:false, modelLevel:true,
//   resetAt}。记 (账号, 模型) 注册表后换下一账号，不冷却本账号（同凭证其它模型健康）；
// - 402/积分耗尽 → quota_exhausted（base 内建 12h 冷却）；
// - 401/403 → auth（base 标 needs_login）；5xx/网络 → server；其余 → client。
//
// Anthropic 事件 → message JSON 的聚合抄自 pools/trae/index.mjs（不 import 池实现，简报约束）。

import path from 'node:path';
import { HttpError } from '../../http/errors.mjs';
import { createPoolScheduler, sessionKeyOf } from '../base.mjs';
import { loadAccounts, saveAccounts } from '../zcode/accounts.mjs';
import { endpointFor, poolNameFor, CHAT_PATH } from './constants.mjs';
import { authHeaders, loadIdentitySeed } from './headers.mjs';
import { buildWbPayload } from './payload.mjs';
import { consumeWbSse, WbStreamError } from './stream.mjs';
import { createTokenManager } from './auth.mjs';
import { createWorkbuddyQuotaCache } from './quota.mjs';
import { createRateLimitRegistry, parseResetTime, modelRateLimitMessage } from './ratelimit.mjs';
import { createWorkbuddyModelCatalog } from './models.mjs';

/** HTTP 层错误分类（流内业务信封经 stream.mjs businessErrorOf 同样落到这里）。 */
export function classifyUpstreamError(status, bodyText, { now = Date.now } = {}) {
  let code = null;
  let msg = '';
  try {
    const json = JSON.parse(bodyText);
    code = typeof json?.code === 'number' ? json.code : (typeof json?.error?.code === 'number' ? json.error.code : null);
    msg = String(json?.msg ?? json?.error?.message ?? '');
  } catch {
    // 非 JSON 体按 HTTP 状态分类
  }
  // 6004 模型级限流（任何 HTTP 状态下出现业务码 6004 都按模型级处理）
  if (code === 6004) {
    return {
      kind: 'client',
      code: 6004,
      retryable: false,
      modelLevel: true,
      resetAt: parseResetTime(msg, now()),
      message: msg || '模型触发上游频率限制',
    };
  }
  if (code === 402 || status === 402) {
    return { kind: 'quota_exhausted', code: code ?? 402, retryable: true, message: `WorkBuddy 积分耗尽（${msg || 402}）` };
  }
  if (status === 401 || status === 403) {
    return { kind: 'auth', code: status, retryable: false, message: 'WorkBuddy 凭证失效，需要重新登录' };
  }
  if (status === 429) return { kind: 'rate_limit', code: code ?? 429, retryable: true, message: 'WorkBuddy 上游限流' };
  if (status >= 500) return { kind: 'server', code: status, retryable: true, message: `WorkBuddy 上游错误 ${status}` };
  return { kind: 'client', code: code ?? status, retryable: false, message: `WorkBuddy 上游拒绝了请求 ${status}${msg ? `：${msg}` : ''}` };
}

function errorFrom(cls, status) {
  const httpStatus = cls.httpStatus ?? (cls.modelLevel || cls.kind === 'rate_limit' || cls.kind === 'quota_exhausted' ? 429 : cls.kind === 'server' ? 502 : status || 502);
  const err = new HttpError(httpStatus, cls.message, {
    type:
      cls.modelLevel || cls.kind === 'rate_limit' || cls.kind === 'quota_exhausted'
        ? 'rate_limit_error'
        : cls.kind === 'auth'
          ? 'authentication_error'
          : cls.kind === 'client'
            ? 'invalid_request_error'
            : 'api_error',
  });
  if (cls.modelLevel) err.modelLevel = true; // dispatch 据此在候选耗尽时直接抛本错误（文案带重置时间）
  return err;
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
      else if (ev.delta?.type === 'input_json_delta') block.__parts.push(ev.delta.partial_json ?? '');
    } else if (ev.type === 'message_delta') {
      stopReason = ev.delta?.stop_reason ?? stopReason;
      usage = { ...usage, ...(ev.usage ?? {}) };
    }
  }
  const base = message ?? {
    id: 'msg_workbuddy',
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

export function createWorkbuddyPool({
  accounts = [],
  config = {},
  fetchImpl = fetch,
  rng = Math.random,
  now = Date.now,
  region = 'cn',
} = {}) {
  const name = poolNameFor(region);
  const endpoint = config.endpoint || endpointFor(region);
  const dataDir = config.dataDir || '.';
  const upstreamTimeoutMs = config.upstreamTimeoutMs ?? 600_000;
  const chatUrl = config.endpoints?.chat || `${endpoint}${CHAT_PATH}`;
  const accountsFile = config.accountsFile || path.join(dataDir, 'pools', name, 'accounts.json');
  const identitySeed = config.identitySeed ?? loadIdentitySeed(dataDir, region);

  const ratelimit = config.ratelimit || createRateLimitRegistry({ now });
  const quota =
    config.quota ||
    createWorkbuddyQuotaCache({ region, endpoint: config.endpoints?.biz || endpoint, fetchImpl, now });
  const catalog = createWorkbuddyModelCatalog({ region, endpoint: config.endpoints?.models || endpoint, fetchImpl, now, realmBases: config.realmBases });

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
  const tokens = createTokenManager({ fetchImpl, now, endpoint: config.endpoints?.auth || endpoint });

  /** 刷新出的新 auth 整组立即原子落盘（对齐 wheel _save_session 整文件替换语义）。 */
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
      console.error(`[wb] token patch 落盘失败（${accId}）：${err?.message}`);
    }
  }

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
    return new HttpError(429, `所有 WorkBuddy 账号暂不可用，约 ${Math.max(1, Math.ceil(waitMs / 60_000))} 分钟后恢复${suffix}`, {
      type: 'rate_limit_error',
    });
  }

  async function dispatch({ req, res, body, key, signal, collect }) {
    let lastError = null;
    const tried = new Set();
    const stickyKey = sessionKeyOf({ req, body, keyId: key?.id });
    const upstreamModel = body.model;

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
      if (!acc) {
        if (lastError?.modelLevel) throw lastError; // 6004 全账号命中：错误文案必须带重置时间
        throw unavailable(lastError?.message);
      }
      tried.add(acc.id);

      // 6004 fast-fail：该账号此模型还在声明窗口内 → 不打上游，换下一个账号
      const throttledUntil = ratelimit.fastFail(acc.id, upstreamModel);
      if (throttledUntil) {
        lastError = errorFrom({ modelLevel: true, message: modelRateLimitMessage(upstreamModel, throttledUntil) }, 429);
        continue;
      }

      const { token, patch } = await tokens.accessFor(acc);
      if (!token) {
        scheduler.onUpstreamError(acc, { kind: 'auth', code: 0, retryable: false, message: '无可用凭证' });
        lastError = new HttpError(502, `账号 ${acc.id} 缺少可用凭证`, { type: 'api_error' });
        continue;
      }
      if (patch) {
        scheduler.updateAccount(acc.id, patch);
        persistTokenPatch(acc.id, patch);
        Object.assign(acc, patch);
      }
      acc.jwt = token;

      // 签到状态 fire-and-forget（展示项，失败不拖累主链路）
      quota
        .get(acc)
        .then((r) => {
          if (r.checkin) scheduler.updateAccount(acc.id, { checkin: r.checkin });
        })
        .catch(() => {});

      const payload = buildWbPayload(body, upstreamModel);
      const headers = {
        ...authHeaders(acc, { endpoint, seed: identitySeed }),
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      };
      const timeout = AbortSignal.timeout(upstreamTimeoutMs);
      const sig = signal ? AbortSignal.any([signal, timeout]) : timeout;
      acc.inFlight += 1;

      let upstream;
      try {
        upstream = await fetchImpl(chatUrl, {
          method: 'POST',
          headers,
          body: JSON.stringify(payload),
          signal: sig,
        });
      } catch (err) {
        if (signal?.aborted) return;
        scheduler.onUpstreamError(acc, { kind: 'server', code: 0, retryable: true, message: err.message });
        lastError = timeout.aborted
          ? new HttpError(504, `WorkBuddy 上游 ${upstreamTimeoutMs}ms 内无响应`, { type: 'api_error' })
          : new HttpError(502, `连接 WorkBuddy 上游失败：${err.message}`, { type: 'api_error' });
        continue;
      } finally {
        acc.inFlight -= 1;
      }

      if (!upstream.ok) {
        const text = await upstream.text();
        const cls = classifyUpstreamError(upstream.status, text, { now });
        if (cls.modelLevel) {
          // 模型级限流：记注册表、不冷却账号，换下一个账号接着试
          ratelimit.observe(acc.id, upstreamModel, cls.resetAt);
          lastError = errorFrom({ modelLevel: true, message: modelRateLimitMessage(upstreamModel, cls.resetAt) }, 429);
          continue;
        }
        if (cls.kind === 'client' && !cls.retryable) throw errorFrom(cls, upstream.status);
        scheduler.onUpstreamError(acc, cls);
        if (stickyKey) scheduler.stickyClear(stickyKey);
        if (!cls.retryable) throw errorFrom(cls, upstream.status);
        lastError = errorFrom(cls, upstream.status);
        continue;
      }

      // HTTP 200：标准 OpenAI SSE（流内业务信封也在 consumeWbSse 冒出）。collect / 非流式可安全重试。
      const streaming = !collect && body.stream === true;
      let wrote = false;
      const events = [];
      try {
        if (streaming) {
          res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
          wrote = true;
        }
        await consumeWbSse(upstream, {
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
        if (err instanceof WbStreamError) {
          // 流内业务信封：code>=500 按上游错误（可换号重试）分类，其余按 HTTP 语义
          const syntheticStatus = err.biz.code >= 500 ? 500 : 200;
          const cls = classifyUpstreamError(syntheticStatus, JSON.stringify({ code: err.biz.code, msg: err.biz.msg }), { now });
          if (cls.modelLevel) {
            ratelimit.observe(acc.id, upstreamModel, cls.resetAt);
            if (streaming && wrote) {
              writeAnthropicError(res, errorFrom({ modelLevel: true, message: modelRateLimitMessage(upstreamModel, cls.resetAt) }, 429));
              res.end();
              return;
            }
            lastError = errorFrom({ modelLevel: true, message: modelRateLimitMessage(upstreamModel, cls.resetAt) }, 429);
            continue;
          }
          // 流内业务错误照 Trae 坑位处理：先分类记账再决定客户端出口
          scheduler.onUpstreamError(acc, cls);
          if (stickyKey) scheduler.stickyClear(stickyKey);
          if (streaming && wrote) {
            writeAnthropicError(res, errorFrom(cls, 400));
            res.end();
            return;
          }
          if (cls.kind === 'client' && !cls.retryable) throw errorFrom(cls, 400);
          lastError = errorFrom(cls, 400);
          continue;
        }
        scheduler.onUpstreamError(acc, { kind: 'server', code: 0, retryable: true, message: err?.message || 'SSE 解码失败' });
        if (stickyKey) scheduler.stickyClear(stickyKey);
        if (streaming && wrote) {
          writeAnthropicError(res, new HttpError(502, `WorkBuddy 上游流中断：${err?.message}`, { type: 'api_error' }));
          res.end();
          return;
        }
        lastError = new HttpError(502, `WorkBuddy 上游流中断：${err?.message}`, { type: 'api_error' });
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
    region,
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
        verified: m.verified !== false,
      })),
    refreshModels: async () => catalog.refreshModels(state.find((a) => a.jwt) ?? null),
    quota,
    ratelimit,
    send,
    sendCollect,
  };
}
