// 积分包余额 + 签到状态（只读）+ 退避缓存。结构照抄 pools/trae/quota.mjs（不 import）。
//
// 双 region 都查余额：POST {billingEndpoint}/v2/billing/meter/get-user-resource
// （分页 + ProductCode=p_tcaca + Status 0/3 + 有效期窗口），cn 额外查签到状态
// /v2/billing/meter/checkin-activity-status（global 无签到接口 → checkin=null）。
// 上游没有更直接的"余量"端点，ratio 用积分包 remaining/total 聚合；无包则 null
// （调度器按"null 不惩罚"处理，池内权重由 idleBonus/successFactor 决定）。
// 签到失败不拖累余额主链路。

import {
  EP_CHECKIN_STATUS,
  EP_USER_RESOURCE,
  BILLING_ENDPOINT_CN,
  BILLING_ENDPOINT_GLOBAL,
} from './constants.mjs';
import { authHeaders } from './headers.mjs';
import { unwrap } from './auth.mjs';

const DEFAULT_TTL_MS = 5 * 60_000;
const DEFAULT_BACKOFF_MS = 60_000;
const DEFAULT_BACKOFF_MAX_MS = 5 * 60_000;

const entryKey = (acc) => String(acc?.id ?? acc?.uid ?? 'unknown');

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** 本地时区 'YYYY-MM-DD HH:mm:ss'（上游按本地日历算有效期窗口）。 */
function localStamp(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/**
 * 时间归一为毫秒：裸数字按秒/毫秒判别；'YYYY-MM-DD HH:mm:ss' 按 UTC+8 解析
 * （CodeBuddy 计费面是腾讯系服务，无时区后缀即北京时间）；带 Z/偏移的 ISO 走 Date.parse。
 */
function msFromStamp(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number' || /^\d+(\.\d+)?$/.test(String(v).trim())) {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) return null;
    return n < 1e12 ? Math.round(n * 1000) : Math.round(n);
  }
  const s = String(v).trim();
  if (/(z|[+-]\d{2}:?\d{2})$/i.test(s)) {
    const t = Date.parse(s);
    return Number.isFinite(t) ? t : null;
  }
  let iso = s.replace(' ', 'T');
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) iso += 'T00:00:00';
  const t = Date.parse(`${iso}+08:00`);
  return Number.isFinite(t) ? t : null;
}

/** Response 双层信封与扁平信封都接受（不同网关版本信封不一）。 */
function accountsOf(data) {
  const candidates = [
    data?.Response?.Data?.Accounts,
    data?.Response?.accounts,
    data?.Data?.Accounts,
    data?.Accounts,
  ];
  for (const c of candidates) if (Array.isArray(c)) return c;
  return [];
}

const firstOf = (obj, keys) => {
  for (const k of keys) {
    const v = obj?.[k];
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
};

function packageDetail(pkg) {
  const cycleSize = Number(pkg?.CycleCapacitySize);
  const recurring = Number.isFinite(cycleSize) && cycleSize > 0;
  const total = num(firstOf(pkg, ['CycleCapacitySize', 'CapacitySize', 'CycleCapacitySizePrecise', 'CapacitySizePrecise']));
  const remaining = num(firstOf(pkg, ['CycleCapacityRemain', 'CapacityRemain', 'CycleCapacityRemainPrecise', 'CapacityRemainPrecise']));
  const used = num(firstOf(pkg, ['CycleCapacityUsed', 'CapacityUsed', 'CycleCapacityUsedPrecise', 'CapacityUsedPrecise']));
  const expiresAt = msFromStamp(firstOf(pkg, ['CycleEndTime', 'DeductionEndTime']));
  const valid = remaining !== null && total !== null && total > 0;
  return {
    name: pkg?.PackageName || '积分包',
    remaining,
    total: total !== null && total > 0 ? total : null,
    unit: 'credits',
    percent: valid ? Math.min(1, Math.max(0, remaining / total)) : null,
    kind: recurring ? 'recurring' : 'package',
    expiresAt,
    used,
  };
}

function parseResource(json, nowMs) {
  const packages = accountsOf(json).map(packageDetail);
  let remainingSum = 0;
  let totalSum = 0;
  let periodEnd = null;
  for (const d of packages) {
    if (d.remaining !== null && d.total !== null) {
      remainingSum += d.remaining;
      totalSum += d.total;
    }
    if (d.expiresAt !== null && d.expiresAt > nowMs && (periodEnd === null || d.expiresAt < periodEnd)) periodEnd = d.expiresAt;
  }
  return {
    details: packages,
    periodEnd,
    ratio: totalSum > 0 ? Math.min(1, Math.max(0, remainingSum / totalSum)) : null,
  };
}

function checkinFrom(json) {
  if (!json || typeof json !== 'object') return null;
  const checkedIn = json.today_checked_in ?? json.checked_in ?? json.checkedIn;
  const credits = json.credits ?? json.today_credit;
  if (checkedIn === undefined && credits === undefined) return null;
  const checkin = {
    checked_in: checkedIn === true,
    credits: num(credits) ?? 0,
  };
  if (json.active !== undefined) checkin.active = json.active === true;
  if (num(json.streak_days) !== null) checkin.streak_days = num(json.streak_days);
  if (num(json.daily_credit) !== null) checkin.daily_credit = num(json.daily_credit);
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

export function createWorkbuddyQuotaCache({
  region,
  endpoint,
  billingEndpoint = region === 'global' ? BILLING_ENDPOINT_GLOBAL : BILLING_ENDPOINT_CN,
  checkinEndpoint = billingEndpoint,
  fetchImpl = fetch,
  now = Date.now,
  ttlMs = DEFAULT_TTL_MS,
  backoffBaseMs = DEFAULT_BACKOFF_MS,
  backoffMaxMs = DEFAULT_BACKOFF_MAX_MS,
  timeoutMs = 10_000,
} = {}) {
  const cache = new Map();
  const inflight = new Map();

  async function fetchResource(acc) {
    const res = await fetchImpl(`${billingEndpoint}${EP_USER_RESOURCE}`, {
      method: 'POST',
      headers: authHeaders(acc, { endpoint: billingEndpoint }),
      body: JSON.stringify({
        PageNumber: 1,
        PageSize: 100,
        ProductCode: 'p_tcaca',
        Status: [0, 3],
        PackageEndTimeRangeBegin: localStamp(now()),
        PackageEndTimeRangeEnd: '2126-12-31 23:59:59',
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`积分包查询失败 HTTP ${res.status}`);
    return parseResource(unwrap(await res.json()), now());
  }

  async function fetchCheckin(acc) {
    const res = await fetchImpl(`${checkinEndpoint}${EP_CHECKIN_STATUS}`, {
      method: 'POST',
      headers: authHeaders(acc, { endpoint: checkinEndpoint }),
      body: '{}',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`签到状态查询失败 HTTP ${res.status}`);
    return checkinFrom(unwrap(await res.json()));
  }

  async function attempt(acc, key) {
    try {
      const parsed = await fetchResource(acc);
      const next = {
        ...parsed,
        checkin: null,
        fetchedAt: now(),
        error: null,
        failures: 0,
        nextAttemptAt: 0,
      };
      cache.set(key, next);
      // 签到状态是展示项（仅 cn）：慢/失败不拖余额主链路，成功后回填同一条目
      if (region === 'cn') {
        try {
          next.checkin = await fetchCheckin(acc);
        } catch {
          // 保留 null，下次刷新再试
        }
      }
      return resultOf(next, 'live');
    } catch (err) {
      const previous = cache.get(key) ?? { ratio: null, details: [], periodEnd: null, checkin: null, fetchedAt: 0, failures: 0 };
      const failures = (previous.failures ?? 0) + 1;
      const backoff = Math.min(backoffBaseMs * 2 ** (failures - 1), backoffMaxMs);
      const next = { ...previous, error: err?.message || '积分包查询失败', failures, nextAttemptAt: now() + backoff };
      cache.set(key, next);
      return resultOf(next, previous.ratio === null && !previous.fetchedAt ? 'unknown' : 'stale', next.error);
    }
  }

  async function get(acc) {
    const key = entryKey(acc);
    const t = now();
    const entry = cache.get(key);
    if (entry && !entry.error && t - entry.fetchedAt < ttlMs) {
      return resultOf(entry, 'live');
    }
    if (entry && entry.nextAttemptAt > t) {
      return resultOf(entry, entry.ratio === null && !entry.details?.length ? 'unknown' : 'stale', entry.error);
    }
    const pending = inflight.get(key);
    if (pending) return pending;
    const promise = attempt(acc, key).finally(() => inflight.delete(key));
    inflight.set(key, promise);
    return promise;
  }

  /** 调度器 quotaRatio 挂点：最近一次成功聚合值；无包/无数据返回 null（不惩罚）。 */
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
