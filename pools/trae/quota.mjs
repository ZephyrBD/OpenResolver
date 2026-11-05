// 积分查询 + 签到状态（只读）+ 退避缓存。结构照抄 pools/qoder/quota.mjs（不 import）。
//
// 端点/头/字段名参照 vendor/cpa-trae/trae/upstream/client.go（MIT）：ide_user_ent_usage 的
// user_entitlement_pack_list[].entitlement_base_info.quota.credits_limit、checkin_credits/status
// 的 did 参数。两类请求都走 ugHeaders（VSCode 插件进程 UA 指纹，与对话的 Trae/0.1.61
// 绝不能混，headers.go:62-73）。
//
// ratio 口径：可见包过滤 + remaining 求和来自 vendor CreditsPoolUsage（去 PROMO_CODE/
// 隐藏/已取消，Σ max(credits_limit - round(credits_amount), 0)），比率（remaining/total）
// 在本地派生——vendor 只给绝对剩余，不返回比率。任一可见包 credits_limit === -1 →
// 整体不限量（ratio 1）；无可见包或无正额度 → null。明细与 ratio 同源，额度条才会
// 跟随实际已用积分变化。签到 claim 端点本次不实现（简报裁决），status 只读进快照。

import { DEFAULT_BIZ_HOST, EP_ENT_USAGE, EP_CHECKIN_STATUS } from './constants.mjs';
import { ugHeaders } from './headers.mjs';

const DEFAULT_TTL_MS = 5 * 60_000;
const DEFAULT_BACKOFF_MS = 60_000;
const DEFAULT_BACKOFF_MAX_MS = 5 * 60_000;

const entryKey = (acc) => String(acc?.id ?? acc?.uid ?? 'unknown');
const clamp01 = (n) => Math.min(1, Math.max(0, n));

/** 可见包过滤，对齐 vendor client.go CreditsPoolUsage：去 PROMO_CODE(3)/隐藏/已取消(status 3)。 */
function visiblePacks(json) {
  const packs = json?.user_entitlement_pack_list;
  if (!Array.isArray(packs)) return [];
  return packs.filter((pack) => {
    const base = pack?.entitlement_base_info ?? {};
    if (base.product_type === 3) return false;
    if (base.is_hide === true) return false;
    if (base.status === 3) return false;
    return true;
  });
}

function ratioFrom(json) {
  let total = 0;
  let remaining = 0;
  for (const pack of visiblePacks(json)) {
    const limit = Number(effectiveQuotaOf(pack)?.credits_limit);
    if (limit === -1) return 1;
    if (!Number.isFinite(limit) || limit <= 0) continue;
    const rawUsed = Number(pack?.usage?.credits_amount);
    const used = Number.isFinite(rawUsed) ? Math.round(rawUsed) : 0;
    total += limit;
    remaining += Math.max(0, limit - used);
  }
  return total > 0 ? clamp01(remaining / total) : null;
}

// product_type → 展示 kind（client.go EntitlementPack 注释：0=Free,1=Pro,4=Pro+,
// 5=Pro+CN,6=Ultra,8=Lite,9=Trial,100=CNExpress；3=PROMO_CODE 已废弃不映射）。
const PRODUCT_KINDS = { 0: 'free', 1: 'pro', 4: 'pro+', 5: 'pro+cn', 6: 'ultra', 8: 'lite', 9: 'trial', 100: 'cnexpress' };

/** quota 三层探测（对齐 client.go EffectiveQuota：base ?? subscription_extra ?? package_extra）。 */
function effectiveQuotaOf(pack) {
  const layers = [
    pack?.entitlement_base_info?.quota,
    pack?.entitlement_base_info?.product_extra?.subscription_extra?.quota,
    pack?.entitlement_base_info?.product_extra?.package_extra?.quota,
  ];
  for (const q of layers) {
    if (q && typeof q === 'object' && Object.values(q).some((v) => Number.isFinite(Number(v)))) return q;
  }
  return null;
}

function msFromEpoch(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n < 1e12 ? n * 1000 : n;
}

function detailsFrom(json) {
  let periodEnd = null;
  const details = visiblePacks(json).map((pack) => {
    const base = pack?.entitlement_base_info ?? {};
    const type = Number(base.product_type);
    const kind = PRODUCT_KINDS[type] ?? 'other';
    const limit = Number(effectiveQuotaOf(pack)?.credits_limit);
    const used = Number(pack?.usage?.credits_amount);
    const unlimited = Number.isFinite(limit) && limit < 0;
    const total = Number.isFinite(limit) && limit > 0 ? limit : null;
    const remaining = total !== null ? Math.max(0, limit - Math.round(Number.isFinite(used) ? used : 0)) : null;
    const expiresAt = msFromEpoch(base.end_time);
    if (expiresAt !== null && (periodEnd === null || expiresAt > periodEnd)) periodEnd = expiresAt;
    return {
      name: pack?.display_desc || `套餐 ${base.product_type}`,
      remaining,
      total,
      unit: 'credits',
      percent: total !== null && remaining !== null ? clamp01(remaining / total) : null,
      kind: unlimited ? 'unlimited' : kind,
      expiresAt,
    };
  });
  return { details, periodEnd };
}

function checkinFrom(json) {
  if (!json || typeof json !== 'object') return null;
  const checked_in = json.checked_in;
  const credits = json.credits;
  if (checked_in === undefined && credits === undefined) return null;
  const checkin = {
    checked_in: checked_in === true,
    credits: Number.isFinite(Number(credits)) ? Number(credits) : 0,
    enable: json.enable === true,
  };
  if (Number.isFinite(Number(json.streak_days))) checkin.streak_days = Number(json.streak_days);
  return checkin;
}

function resultOf(entry, source, error) {
  return {
    supported: true,
    ratio: entry?.ratio ?? null,
    source,
    fetchedAt: entry?.fetchedAt ?? 0,
    plan: null,
    periodEnd: entry?.periodEnd ?? null,
    details: entry?.details ?? [],
    checkin: entry?.checkin ?? null,
    ...(error ? { error } : {}),
  };
}

export function createTraeQuotaCache({
  bizHost = DEFAULT_BIZ_HOST,
  usageUrl,
  checkinUrl,
  fetchImpl = fetch,
  now = Date.now,
  ttlMs = DEFAULT_TTL_MS,
  backoffBaseMs = DEFAULT_BACKOFF_MS,
  backoffMaxMs = DEFAULT_BACKOFF_MAX_MS,
  timeoutMs = 10_000,
} = {}) {
  const cache = new Map();
  const inflight = new Map();

  async function fetchUsage(acc) {
    const res = await fetchImpl(usageUrl || `${bizHost}${EP_ENT_USAGE}`, {
      method: 'POST',
      headers: ugHeaders({ jwt: acc.jwt }),
      body: '{}',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`积分查询失败 HTTP ${res.status}`);
    return await res.json();
  }

  async function fetchCheckin(acc) {
    // vendor 已证弃用（client.go:556-563：checkin_credits/status 的 GET + did 契约已下线）——
    // 真机冒烟优先验证本端点；失败仅静默跳过，不拖累 ratio 主链路。
    const did = acc.deviceId || acc.machineId || '';
    const base = checkinUrl || `${bizHost}${EP_CHECKIN_STATUS}`;
    const res = await fetchImpl(`${base}${base.includes('?') ? '&' : '?'}did=${encodeURIComponent(did)}`, {
      method: 'GET',
      headers: ugHeaders({ jwt: acc.jwt, deviceId: did || undefined }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`签到状态查询失败 HTTP ${res.status}`);
    return checkinFrom(await res.json());
  }

  async function attempt(acc, key) {
    try {
      const json = await fetchUsage(acc);
      const next = {
        ratio: ratioFrom(json),
        ...detailsFrom(json),
        checkin: null,
        fetchedAt: now(),
        error: null,
        failures: 0,
        nextAttemptAt: 0,
      };
      cache.set(key, next);
      // 签到状态是展示项：慢/失败不拖 ratio 主链路，成功后回填同一条目
      try {
        next.checkin = await fetchCheckin(acc);
      } catch {
        // 保留 null，下次刷新再试
      }
      return resultOf(next, 'live');
    } catch (err) {
      const previous = cache.get(key) ?? { ratio: null, checkin: null, fetchedAt: 0, failures: 0 };
      const failures = (previous.failures ?? 0) + 1;
      const backoff = Math.min(backoffBaseMs * 2 ** (failures - 1), backoffMaxMs);
      const next = { ...previous, error: err?.message || '积分查询失败', failures, nextAttemptAt: now() + backoff };
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
    const pending = inflight.get(key);
    if (pending) return pending;
    const promise = attempt(acc, key).finally(() => inflight.delete(key));
    inflight.set(key, promise);
    return promise;
  }

  /** 同步读最近一次成功值，供调度器 quotaRatio 用；无数据返回 null。 */
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
