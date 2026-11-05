import { deviceIdFor, sessionIdFor } from '../../fingerprint.mjs';

/**
 * ZCode 额度查询 + 缓存（文档 §6.1 缺陷 5）。
 *
 * 上游 GET /api/v1/zcode-plan/billing/balance 必须带 x-device-mid（缺失回 3001）。
 * 成功缓存 5 min；失败不静默归零，保留旧值标记 stale，并按 60s 起、翻倍、封顶 5min 退避。
 * 任何异常都只反映在返回值里 —— 额度只是调度参考，绝不能让 send 失败。
 */

const BALANCE_PATH = '/api/v1/zcode-plan/billing/balance';
const DEFAULT_TTL_MS = 5 * 60_000;
const DEFAULT_BACKOFF_MS = 60_000;
const DEFAULT_BACKOFF_MAX_MS = 5 * 60_000;

/** 缓存按账号 id 分桶（label 可改、不可靠），不再用 label。 */
const entryKey = (acc) => String(acc?.id ?? acc?.uid ?? 'unknown');

function headersFor(acc, appVersion) {
  const headers = {
    accept: 'application/json',
    'x-device-mid': acc.deviceId || deviceIdFor(acc.uid),
    'x-zcode-app-version': appVersion,
    'x-session-id': acc.sessionId || sessionIdFor(acc.uid),
  };
  if (acc.jwt) headers.authorization = `Bearer ${acc.jwt}`;
  return headers;
}

function ratioFrom(json) {
  const balances = json?.data?.balances;
  if (!Array.isArray(balances) || !balances.length) return null;
  let remaining = 0;
  let total = 0;
  for (const bucket of balances) {
    const r = Number(bucket?.remaining_units);
    const t = Number(bucket?.total_units);
    if (!Number.isFinite(r) || !Number.isFinite(t) || t <= 0) continue;
    remaining += r;
    total += t;
  }
  if (total <= 0) return null;
  return Math.min(1, Math.max(0, remaining / total));
}

/** 上游时间戳秒/毫秒都接受，统一归一为毫秒；非法值归 null。 */
function msFromEpoch(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n < 1e12 ? n * 1000 : n;
}

function planKindOf(planId) {
  const s = String(planId ?? '');
  if (/off_?peak/i.test(s)) return 'offpeak';
  if (/daily/i.test(s)) return 'daily';
  if (/promo/i.test(s)) return 'promo';
  if (/paid/i.test(s)) return 'paid';
  return 'other';
}

function detailsFrom(json) {
  const balances = json?.data?.balances;
  if (!Array.isArray(balances)) return [];
  return balances.map((bucket) => {
    const remaining = Number(bucket?.remaining_units);
    const total = Number(bucket?.total_units);
    const valid = Number.isFinite(remaining) && Number.isFinite(total) && total > 0;
    return {
      name: bucket?.show_name ?? '余额',
      remaining: Number.isFinite(remaining) ? remaining : null,
      total: valid ? total : null,
      unit: 'tokens',
      percent: valid ? Math.min(1, Math.max(0, remaining / total)) : null,
      kind: planKindOf(bucket?.plan_id),
      expiresAt: msFromEpoch(bucket?.period_end),
    };
  });
}

/** 取生效计划里 ends_at 最大的那条（无 active 标记则全部参选）。 */
function planFrom(json) {
  const plans = json?.data?.plans;
  if (!Array.isArray(plans) || !plans.length) return { plan: null, periodEnd: null };
  const isActive = (p) => p?.is_active === true || p?.active === true || p?.status === 'active';
  const pool = plans.filter(isActive);
  const candidates = pool.length ? pool : plans;
  let best = null;
  for (const p of candidates) {
    const end = msFromEpoch(p?.ends_at ?? p?.end_at);
    if (end !== null && (best === null || end > best.end)) best = { p, end };
  }
  const chosen = best?.p ?? candidates[0];
  return {
    plan: chosen?.plan_name ?? chosen?.plan ?? chosen?.name ?? null,
    periodEnd: best?.end ?? null,
  };
}

function resultOf(entry, source, error) {
  return {
    supported: true,
    ratio: entry?.ratio ?? null,
    source,
    fetchedAt: entry?.fetchedAt ?? 0,
    plan: entry?.plan ?? null,
    periodEnd: entry?.periodEnd ?? null,
    details: entry?.details ?? [],
    checkin: null,
    ...(error ? { error } : {}),
  };
}

export function createQuotaCache({
  origin = 'https://zcode.z.ai',
  appVersion = '3.16.3',
  fetchImpl = fetch,
  now = Date.now,
  ttlMs = DEFAULT_TTL_MS,
  backoffBaseMs = DEFAULT_BACKOFF_MS,
  backoffMaxMs = DEFAULT_BACKOFF_MAX_MS,
  timeoutMs = 10_000,
} = {}) {
  const url = `${origin}${BALANCE_PATH}`;
  const cache = new Map();
  const inflight = new Map();

  async function fetchRatio(acc) {
    const res = await fetchImpl(url, {
      method: 'GET',
      headers: headersFor(acc, appVersion),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`额度查询失败 HTTP ${res.status}`);
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error('额度响应不是合法 JSON');
    }
    const ratio = ratioFrom(json);
    if (ratio === null) throw new Error('额度响应缺少 balances');
    return { ratio, ...planFrom(json), details: detailsFrom(json) };
  }

  async function attempt(acc, key) {
    try {
      const parsed = await fetchRatio(acc);
      const next = { ...parsed, fetchedAt: now(), error: null, failures: 0, nextAttemptAt: 0 };
      cache.set(key, next);
      return resultOf(next, 'live');
    } catch (err) {
      const previous = cache.get(key) ?? { ratio: null, fetchedAt: 0, failures: 0 };
      const failures = (previous.failures ?? 0) + 1;
      const backoff = Math.min(backoffBaseMs * 2 ** (failures - 1), backoffMaxMs);
      const next = {
        ...previous,
        error: err?.message || '额度查询失败',
        failures,
        nextAttemptAt: now() + backoff,
      };
      cache.set(key, next);
      return resultOf(next, next.ratio === null ? 'unknown' : 'stale', next.error);
    }
  }

  async function get(acc) {
    const key = entryKey(acc);
    const t = now();
    const entry = cache.get(key);

    if (entry && entry.ratio !== null && !entry.error && t - entry.fetchedAt < ttlMs) {
      return resultOf(entry, 'live');
    }
    if (entry && entry.nextAttemptAt > t) {
      return resultOf(entry, entry.ratio === null ? 'unknown' : 'stale', entry.error);
    }

    // 同一账号的并发查询共享一个请求，避免面板/调度同时回源把上游打爆
    const pending = inflight.get(key);
    if (pending) return pending;
    const promise = attempt(acc, key).finally(() => inflight.delete(key));
    inflight.set(key, promise);
    return promise;
  }

  /** 同步读最近一次成功值，供调度器 quotaRatio 使用；无数据返回 null。 */
  function peek(acc) {
    const entry = cache.get(entryKey(acc));
    return typeof entry?.ratio === 'number' ? entry.ratio : null;
  }

  /** 领取成功后清缓存：按账号删 entry（连同退避计数），下个 get 即回源；无参全清。 */
  function invalidate(acc) {
    if (acc == null) {
      cache.clear();
      return;
    }
    cache.delete(entryKey(acc));
  }

  return { get, peek, invalidate };
}
