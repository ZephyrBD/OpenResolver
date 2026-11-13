// 积分包余额 + 签到状态（只读）。缓存骨架共用 pools/quota-cache.mjs，本文件只保留上游事实。
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

import { createQuotaCacheSkeleton } from '../quota-cache.mjs';

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

  return createQuotaCacheSkeleton({
    now,
    ttlMs,
    backoffBaseMs,
    backoffMaxMs,
    fetchOne: (acc) => fetchResource(acc),
    // 签到状态是展示项（仅 cn）：慢/失败不拖余额主链路，成功后回填同一条目
    afterFetch: async (entry, acc) => (region === 'cn' ? { checkin: await fetchCheckin(acc) } : {}),
    toResult: resultOf,
    errorOf: (err) => err?.message || '积分包查询失败',
    staleSource: (entry) => (entry.ratio === null && !entry.fetchedAt ? 'unknown' : 'stale'),
  });
}

