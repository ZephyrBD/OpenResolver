import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { HttpError } from '../../http/errors.mjs';
import { deviceIdFor, sessionIdFor } from '../../fingerprint.mjs';
import { createPoolScheduler, sessionKeyOf } from '../base.mjs';
import { DEFAULT_SETTINGS } from '../settings.mjs';
import { buildUpstreamBody } from './upstream.mjs';
import { createQuotaCache } from './quota.mjs';

/**
 * 冷却时长仍从这里导出（老调用方兼容）；真实值来自 pools/settings.mjs，避免两处漂移。
 */
export const COOLDOWN = Object.freeze({
  blocked: DEFAULT_SETTINGS.blockedCooldownMs, // 3012 指纹/风控
  busy: DEFAULT_SETTINGS.busyCooldownMs, // 限流首犯
  quota: DEFAULT_SETTINGS.quotaCooldownMs, // 限流连犯
  server: DEFAULT_SETTINGS.serverCooldownMs, // 5xx / 网络错误
});

function safeParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function headersFor(acc, appVersion, origin) {
  return {
    authorization: `Bearer ${acc.jwt}`,
    'x-api-key': acc.jwt,
    'content-type': 'application/json',
    'anthropic-version': '2023-06-01',
    'anthropic-beta': 'mid-conversation-system-2026-04-07',
    'user-agent': `ZCode/${appVersion} ai-sdk/provider-utils/4.0.27 runtime/node.js/24`,
    'http-referer': origin,
    'x-zcode-app-version': appVersion,
    'x-title': 'Z Code@electron',
    'x-release-channel': 'production',
    'x-platform': 'linux-x64',
    'x-os-category': 'linux',
    'x-os-version': '5.15.0',
    'x-client-timezone': 'Asia/Shanghai',
    'x-client-language': 'zh-CN',
    'x-device-mid': acc.deviceId,
    'x-session-id': acc.sessionId,
    'x-query-id': crypto.randomUUID(),
    'x-request-id': crypto.randomUUID().replace(/-/g, ''),
    'x-zcode-trace-id': crypto.randomUUID(),
    'x-zcode-agent': 'glm',
    'x-zcode-query-source': 'main_turn',
    'x-zcode-session-type': 'main',
    accept: 'text/event-stream, application/json',
  };
}

/**
 * 上游会在 HTTP 200 里塞业务错误信封（实测 `{"code":1005,"msg":"exceed quota limit"}`），
 * 只看状态码会把错误当成功透传。返回 null 表示这是正常响应。
 */
export function businessErrorOf(json) {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return null;
  if (json.type === 'message' || Array.isArray(json.content)) return null;
  const code = json.error?.biz_code ?? json.biz_code ?? json.code ?? json.error?.code;
  if (code === undefined || code === null || code === 0 || code === 200) return null;
  return { code, message: json.error?.message || json.msg || `上游业务错误 ${code}` };
}

/**
 * 上游错误分类。kind 决定冷却时长与是否换号：
 * blocked(3012) / rate_limit(1005,3009,429) / server(5xx,网络) / auth(401,403) / client(其余 4xx)
 */
export function classifyUpstreamError(status, bodyText) {
  const env = safeParse(bodyText);
  const biz = envelopeCode(env);

  if (biz === 3012) {
    return { kind: 'blocked', code: 3012, retryable: true, message: 'ZCode 指纹被风控拒绝（3012）' };
  }
  if (biz === 1005 || biz === 3009) {
    return { kind: 'rate_limit', code: biz, retryable: true, message: `ZCode 额度受限（${biz}）` };
  }
  if (status === 429) {
    return { kind: 'rate_limit', code: 429, retryable: true, message: 'ZCode 上游限流' };
  }
  if (status === 401 || status === 403) {
    return { kind: 'auth', code: status, retryable: false, message: 'ZCode 凭证失效，需要重新登录' };
  }
  if (status >= 500) {
    return { kind: 'server', code: status, retryable: true, message: `ZCode 上游错误 ${status}` };
  }
  return { kind: 'client', code: status, retryable: false, message: `ZCode 上游拒绝了请求 ${status}` };
}

function envelopeCode(env) {
  if (!env || typeof env !== 'object') return null;
  const code = env.error?.biz_code ?? env.biz_code ?? env.code ?? env.error?.code;
  return typeof code === 'number' ? code : null;
}

function errorFrom(cls, status) {
  const httpStatus = cls.kind === 'rate_limit' ? 429 : cls.kind === 'server' ? 502 : status;
  return new HttpError(httpStatus, cls.message, {
    type: cls.kind === 'rate_limit' ? 'rate_limit_error' : cls.kind === 'auth' ? 'authentication_error' : 'api_error',
  });
}

export function createZcodePool({
  accounts = [],
  profile,
  config = {},
  fetchImpl = fetch,
  rng = Math.random,
  now = Date.now,
} = {}) {
  const origin = config.origin || 'https://zcode.z.ai';
  const appVersion = config.appVersion || '3.16.3';
  const upstreamTimeoutMs = config.upstreamTimeoutMs ?? 600_000;
  const upstreamUrl = `${origin}/api/v1/zcode-plan/anthropic/v1/messages`;
  const quota = config.quota || createQuotaCache({ origin, appVersion, fetchImpl, now });

  const scheduler = createPoolScheduler({
    name: 'zcode',
    accounts: accounts.map((a) => ({
      ...a,
      deviceId: a.deviceId || deviceIdFor(a.uid),
      sessionId: a.sessionId || sessionIdFor(a.uid),
    })),
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
    return new HttpError(
      429,
      `所有 ZCode 账号暂不可用，约 ${Math.max(1, Math.ceil(waitMs / 60_000))} 分钟后恢复${suffix}`,
      { type: 'rate_limit_error' },
    );
  }

  function relay(upstream, res, text) {
    const type = upstream.headers.get('content-type') || 'application/json';
    res.writeHead(upstream.status, { 'content-type': type, 'cache-control': 'no-store' });
    if (text !== undefined) {
      res.end(text);
      return;
    }
    if (!upstream.body) {
      res.end();
      return;
    }
    Readable.fromWeb(upstream.body)
      .on('error', () => res.destroy())
      .pipe(res);
  }

  async function dispatch({ req, res, body, key, signal, collect }) {
    let lastError = null;
    const tried = new Set();
    const stickyKey = sessionKeyOf({ req, body, keyId: key?.id });

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      let acc = null;
      if (stickyKey) {
        if (attempt === 0) {
          const bound = scheduler.stickyGet(stickyKey, { readyOnly: true });
          if (bound && !tried.has(bound.id)) acc = bound;
          else scheduler.stickyClear(stickyKey);
        } else {
          scheduler.stickyClear(stickyKey); // 重试一律解绑，避免失败会话钉在同一账号
        }
      }
      if (!acc) acc = scheduler.pick({ exclude: tried, allowFallback: attempt > 0 });
      if (!acc) throw unavailable(lastError?.message);
      tried.add(acc.id);

      const payload = buildUpstreamBody(body, profile, acc);
      const timeout = AbortSignal.timeout(upstreamTimeoutMs);
      const sig = signal ? AbortSignal.any([signal, timeout]) : timeout;
      acc.inFlight += 1;

      let upstream;
      try {
        upstream = await fetchImpl(upstreamUrl, {
          method: 'POST',
          headers: headersFor(acc, appVersion, origin),
          body: JSON.stringify(payload),
          signal: sig,
        });
      } catch (err) {
        if (signal?.aborted) return;
        scheduler.onUpstreamError(acc, { kind: 'server', code: 0, retryable: true, message: err.message });
        lastError = timeout.aborted
          ? new HttpError(504, `ZCode 上游 ${upstreamTimeoutMs}ms 内无响应`, { type: 'api_error' })
          : new HttpError(502, `连接 ZCode 上游失败：${err.message}`, { type: 'api_error' });
        continue;
      } finally {
        acc.inFlight -= 1;
      }

      const contentType = upstream.headers.get('content-type') || '';

      if (upstream.ok && contentType.includes('application/json')) {
        const text = await upstream.text();
        const biz = businessErrorOf(safeParse(text));
        if (!biz) {
          scheduler.onSuccess(acc);
          if (stickyKey) scheduler.stickySet(stickyKey, acc);
          if (collect) return { status: upstream.status, contentType: contentType || 'application/json', bodyText: text };
          return relay(upstream, res, text);
        }
        const cls = classifyUpstreamError(upstream.status, text);
        scheduler.onUpstreamError(acc, cls);
        if (stickyKey) scheduler.stickyClear(stickyKey);
        if (!cls.retryable) throw errorFrom(cls, upstream.status);
        lastError = errorFrom(cls, upstream.status);
        continue;
      }

      if (upstream.ok) {
        scheduler.onSuccess(acc);
        if (stickyKey) scheduler.stickySet(stickyKey, acc);
        if (collect) {
          const text = await upstream.text();
          return { status: upstream.status, contentType, bodyText: text };
        }
        return relay(upstream, res);
      }

      const text = await upstream.text();
      const cls = classifyUpstreamError(upstream.status, text);
      scheduler.onUpstreamError(acc, cls);
      if (stickyKey) scheduler.stickyClear(stickyKey);
      if (!cls.retryable) throw errorFrom(cls, upstream.status);
      lastError = errorFrom(cls, upstream.status);
    }

    if (signal?.aborted) return;
    throw lastError ?? unavailable();
  }

  function send(args) {
    return dispatch({ ...args, collect: false });
  }

  /** 收集完整上游响应（不写 res），供网关侧做协议转换。错误分类/换号/冷却与 send 完全一致。 */
  function sendCollect(args) {
    return dispatch({ ...args, collect: true });
  }

  return {
    name: 'zcode',
    type: 'pool',
    accounts: state,
    scheduler,
    models: () =>
      (config.models || [
        {
          id: 'GLM-5.3',
          display_name: 'GLM-5.3 (ZCode)',
          context_window: 128000,
          supports_tools: true,
          supports_thinking: true,
        },
        {
          id: 'GLM-5.3-Flash',
          display_name: 'GLM-5.3-Flash (ZCode)',
          context_window: 128000,
          supports_tools: true,
          supports_thinking: true,
        },
      ]).map((m) => ({ ...m, upstream_model: m.id, verified: true })),
    send,
    sendCollect,
    quota,
  };
}
