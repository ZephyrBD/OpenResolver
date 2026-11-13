// 额度查询 + 退避缓存。缓存骨架共用 pools/quota-cache.mjs，本文件只保留上游事实。
// 接口对接 pools/base.mjs 的 quotaRatio(acc) 注入（config.quota.peek）。
// GET {openApiUrl}/api/v2/quota/usage → userQuota.{used,total,remaining,unit}。
// 成功缓存 5min；失败保留旧值标 stale，60s 起翻倍封顶 5min。任何异常不外抛。

import { quotaUrl } from './region.mjs';

import { createQuotaCacheSkeleton } from '../quota-cache.mjs';

const DEFAULT_TTL_MS = 5 * 60_000;
const DEFAULT_BACKOFF_MS = 60_000;
const DEFAULT_BACKOFF_MAX_MS = 5 * 60_000;

const entryKey = (acc) => String(acc?.id ?? acc?.userID ?? 'unknown');

// 超远未来（如 9999-12-31 哨兵）不算到期时间
const MAX_FUTURE_MS = Date.UTC(2100, 0, 1);

function clampRatio(v) {
  return Math.min(1, Math.max(0, v));
}

function ratioFrom(json) {
  const q = json?.userQuota;
  if (q && typeof q === 'object') {
    const total = Number(q.total);
    const remaining = Number(q.remaining);
    if (Number.isFinite(total) && Number.isFinite(remaining)) {
      // total=0 是有效零额度（global personal_standard 实测：0 credits + isQuotaExceeded）
      if (total === 0) return 0;
      if (total > 0) return clampRatio(remaining / total);
    }
  }
  // 组织-only 账号：userQuota 缺失/无效时用组织资源包兜底（保持旧"有值才回"口径）
  const org = json?.orgResourcePackage;
  const oTotal = Number(org?.total);
  const oRemaining = Number(org?.remaining);
  if (Number.isFinite(oTotal) && Number.isFinite(oRemaining) && oTotal > 0) return clampRatio(oRemaining / oTotal);
  return null;
}

/** expiresAt：ISO 字符串或秒/毫秒时间戳，统一归一为毫秒；超远未来值回 null。 */
function msFrom(v) {
  if (v == null) return null;
  if (typeof v !== 'number' && typeof v !== 'string') return null;
  let ms;
  const n = Number(v);
  if (typeof v === 'number' || /^\d+$/.test(String(v).trim())) {
    if (!Number.isFinite(n) || n <= 0) return null;
    ms = n < 1e12 ? n * 1000 : n;
  } else {
    const t = Date.parse(String(v));
    if (!Number.isFinite(t)) return null;
    ms = t;
  }
  return ms > MAX_FUTURE_MS ? null : ms;
}

function detailOf(name, q) {
  const remaining = Number(q?.remaining);
  const total = Number(q?.total);
  const valid = Number.isFinite(remaining) && Number.isFinite(total) && total > 0;
  return {
    name,
    remaining: Number.isFinite(remaining) ? remaining : null,
    total: Number.isFinite(total) ? total : null,
    unit: String(q?.unit || 'credit'),
    percent: valid ? clampRatio(remaining / total) : null,
  };
}

function detailsFrom(json) {
  const details = [];
  if (json?.userQuota && typeof json.userQuota === 'object') details.push(detailOf('用户额度', json.userQuota));
  const org = json?.orgResourcePackage;
  if (org && typeof org === 'object' && Number(org.total) > 0) details.push(detailOf('组织资源包', org));
  return details;
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

export function createQoderQuotaCache({
  mode,
  url,
  fetchImpl = fetch,
  now = Date.now,
  ttlMs = DEFAULT_TTL_MS,
  backoffBaseMs = DEFAULT_BACKOFF_MS,
  backoffMaxMs = DEFAULT_BACKOFF_MAX_MS,
  timeoutMs = 10_000,
} = {}) {

  async function fetchRatio(acc) {
    const res = await fetchImpl(url || quotaUrl(mode), {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${acc.jobToken || acc.pat || ''}`,
      },
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
    if (ratio === null) throw new Error('额度响应缺少 userQuota（且无 orgResourcePackage）');
    return {
      ratio,
      plan: String(json?.userType || '') || null,
      periodEnd: msFrom(json?.expiresAt),
      details: detailsFrom(json),
    };
  }

  return createQuotaCacheSkeleton({
    now,
    ttlMs,
    backoffBaseMs,
    backoffMaxMs,
    fetchOne: (acc) => fetchRatio(acc),
    toResult: resultOf,
  });
}

