// 华为 CodeArts 积分余额 + 活动签到查询 + 缓存。
//
// 余额走 snap-manager 统计插件（credit.mjs，移植 credit.go）；活动积分仍走
// checkin.mjs 的 fetchCreditCampaigns。两路请求并行（Promise.allSettled）：
// credit 成功即视为成功快照，活动失败只让 checkin 为 null，不拖垮 credit。
//
// 缓存语义与其它池一致：5min TTL、失败 60s 起翻倍封顶 5min 退避、invalidate 清条目；
// 失败时保留上一轮 details/ratio/checkin（source=stale），首败 source=unknown。
// details 只输出分类行（基础/按需/赠送），不叠加总额行——/user/balance 会
// sum details[].remaining，叠行就是双计；分类缺失或与总额不自洽时退回单条总额行。
//
// 凭证：STS 只有 ~2h 有效期，额度/签到查询也必须走 token 管理器刷新（credsOf 注入），
// 否则 grant 过期后 /user/balance 与面板额度会一直 401/0，直到某次 chat dispatch 顺手刷新。

import { fetchCreditCampaigns } from './checkin.mjs';
import { fetchCreditInfo, CREDIT_PATH } from './credit.mjs';
import { SNAP_ENGINE_API_HOST } from './constants.mjs';

const DEFAULT_TTL_MS = 5 * 60_000;
const DEFAULT_BACKOFF_MS = 60_000;
const DEFAULT_BACKOFF_MAX_MS = 5 * 60_000;

const entryKey = (acc) => String(acc?.id ?? acc?.uid ?? 'unknown');

const clamp01 = (n) => Math.min(1, Math.max(0, n));

/**
 * 时间归一为毫秒：裸数字按秒/毫秒判别；无时区的 'YYYY-MM-DD HH:mm:ss' 按 UTC+8
 * 解析（华为统计面回的是北京时间；Docker 跑 UTC 时裸 Date.parse 会把周期末尾推后 8h）。
 */
function msFrom(v) {
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

// 分类顺序与命名固定（面板直接展示）。
const CATEGORY_ROWS = [
  { key: 'basic', name: '基础积分', kind: 'credit-basic' },
  { key: 'onDemand', name: '按需积分', kind: 'credit-on-demand' },
  { key: 'bonus', name: '赠送积分', kind: 'credit-bonus' },
];

/**
 * 积分快照 → 额度明细。
 * available=false 时上游没有积分套餐，不输出 0/0 的伪行；分类行必须与总额自洽
 * （|Σ category.total − total| ≤ 0.5），否则退回一条总额行，绝不与分类行并存。
 */
function detailsFrom(info) {
  if (!info.available) return [];
  const rows = [];
  let categoryTotal = 0;
  for (const { key, name, kind } of CATEGORY_ROWS) {
    const category = info[key];
    if (!category) continue;
    const total = Number(category.total) || 0;
    const remaining = Math.max(0, total - (Number(category.used) || 0));
    categoryTotal += total;
    rows.push({
      name,
      remaining,
      total,
      unit: 'credits',
      percent: total > 0 ? remaining / total : null,
      kind,
    });
  }
  const total = Number(info.total) || 0;
  // 分类缺失（如只回总额指标）或求和与总额对不上时不输出分类行：
  // /user/balance 按 details 求和，额度条按 remaining/total，两条口径必须同源。
  if (rows.length && Math.abs(categoryTotal - total) <= 0.5) return rows;
  return [
    {
      name: info.packageName || '积分池',
      remaining: info.remaining,
      total: info.total,
      unit: 'credits',
      percent: info.total > 0 ? info.remaining / info.total : null,
      kind: 'credit',
    },
  ];
}

function checkinFrom(campaigns) {
  const credits = campaigns
    .filter((c) => c.status === 'CONFIRMED' || c.status === 'CONSUMED')
    .reduce((sum, c) => sum + (Number(c.benefitAmount) || 0), 0);
  return { checkedIn: false, credits, message: '' };
}

function resultOf(entry, source, error) {
  return {
    supported: Boolean(entry?.supported),
    ratio: entry?.ratio ?? null,
    source,
    fetchedAt: entry?.fetchedAt ?? 0,
    plan: entry?.plan ?? null,
    periodEnd: entry?.periodEnd ?? null,
    details: entry?.details ?? [],
    checkin: entry?.checkin ?? null,
    ...(entry?.reason ? { reason: entry.reason } : {}),
    ...(error ? { error } : {}),
  };
}

/** 凭证不可用（登录真失效）时的统一错误文案：面板原样展示，指明下一步动作。 */
const CRED_UNAVAILABLE = 'CodeArts 凭证不可用，请重新登录/先发一次请求';

/** 未注入 provider 时的直读（兼容单测/静态账号）：只回显账号上的 STS 三元组。 */
const directCredsOf = (acc) =>
  acc?.accessKeyID
    ? {
        accessKeyID: acc.accessKeyID,
        secretAccessKey: acc.secretAccessKey,
        securityToken: acc.securityToken,
      }
    : null;

export function createCodeartsQuotaCache({
  snapBase,
  creditUrl,
  credsOf = directCredsOf,
  fetchImpl = fetch,
  now = Date.now,
  ttlMs = DEFAULT_TTL_MS,
  backoffBaseMs = DEFAULT_BACKOFF_MS,
  backoffMaxMs = DEFAULT_BACKOFF_MAX_MS,
  timeoutMs = 10_000,
} = {}) {
  const cache = new Map();
  const inflight = new Map();

  const base = snapBase || SNAP_ENGINE_API_HOST;

  /** 每次回源前解析一次凭证（可能触发 token 刷新）；null → 抛明确错误走 stale/unknown。 */
  async function resolveCreds(acc) {
    const cred = await credsOf(acc);
    if (!cred) throw new Error(CRED_UNAVAILABLE);
    return cred;
  }

  async function fetchCredit(cred, signal) {
    return fetchCreditInfo({
      cred,
      fetchImpl,
      url: creditUrl || `${base}${CREDIT_PATH}`,
      signal,
    });
  }

  async function fetchCampaigns(acc, cred, signal) {
    return fetchCreditCampaigns({ cred, snapBase: base, fetchImpl, signal });
  }

  async function attempt(acc, key) {
    // /user/balance 串行 await 每个账号的 get()：两路上游共用同一个超时预算，
    // 否则一个卡死的端点会把 cc-switch 轮询和面板 quota 路由拖到 undici 默认 ~300s。
    const signal = Number.isFinite(timeoutMs) && timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined;
    // 凭证只解析一次（token 管理器内部单飞），两路并行共用同一组 AK/SK/STS。
    let cred = null;
    let credError = null;
    try {
      cred = await resolveCreds(acc);
    } catch (err) {
      credError = err;
    }
    const [creditRes, campaignRes] = cred
      ? await Promise.allSettled([fetchCredit(cred, signal), fetchCampaigns(acc, cred, signal)])
      : [
          { status: 'rejected', reason: credError },
          { status: 'rejected', reason: credError },
        ];

    if (creditRes.status === 'fulfilled') {
      const info = creditRes.value;
      const ratio = info.available && info.total > 0 ? clamp01(info.remaining / info.total) : null;
      const next = {
        supported: info.available,
        ratio,
        plan: info.packageName || null,
        periodEnd: msFrom(info.resetDate),
        details: detailsFrom(info),
        // 活动查询失败只影响签到展示，不能让 credit 成功被降级。
        checkin: campaignRes.status === 'fulfilled' ? checkinFrom(campaignRes.value) : null,
        reason: info.available ? '' : info.reason,
        fetchedAt: now(),
        error: null,
        failures: 0,
        nextAttemptAt: 0,
      };
      cache.set(key, next);
      return resultOf(next, 'live');
    }

    // 失败：保留上一轮 details / ratio / checkin，只更新错误与退避计数。
    const previous = cache.get(key) ?? {
      supported: false,
      ratio: null,
      plan: null,
      periodEnd: null,
      details: [],
      checkin: null,
      reason: '',
      fetchedAt: 0,
      failures: 0,
    };
    const failures = (previous.failures ?? 0) + 1;
    const backoff = Math.min(backoffBaseMs * 2 ** (failures - 1), backoffMaxMs);
    const next = {
      ...previous,
      error: creditRes.reason?.message || '积分额度查询失败',
      failures,
      nextAttemptAt: now() + backoff,
    };
    cache.set(key, next);
    return resultOf(next, previous.fetchedAt ? 'stale' : 'unknown', next.error);
  }

  async function get(acc) {
    const key = entryKey(acc);
    const t = now();
    const entry = cache.get(key);
    if (entry && !entry.error && t - entry.fetchedAt < ttlMs) {
      return resultOf(entry, 'live');
    }
    if (entry && entry.nextAttemptAt > t) {
      return resultOf(entry, entry.fetchedAt ? 'stale' : 'unknown', entry.error);
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
