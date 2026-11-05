// 积分套餐与用量查询（snap-manager 统计插件）。
// 参考实现是同级仓库 D:\Agent Workstation\OpenResolver\codearts2api\internal\codearts\credit.go
// （MIT © HITZY2002，源码真相；vendor/codearts2api/ 只是只读快照，行号以快照为准）：
//   CreditPath :20 / FetchCreditInfo :92-106 / parseCreditInfo :109-160 /
//   creditPackageStatus :181-194。
//
// 注意：它不是已下线的 /api/v1/user/tokens/balance（免费权益通道，2026-10 起回
// `4000: invalid channel`）。这条是积分通道自己的统计接口，返回套餐总额 / 已用 /
// 剩余 / 到期时间，只读、不消耗积分。
//
// 身份头对齐 Go client.go baseHeaders :134-176：上游按 x-ot-session-id 统计并发
// 会话（每账号 3 个），因此 session id 必须按 accessKeyID 稳定派生，不能每请求新造。

import crypto from 'node:crypto';
import { SNAP_ENGINE_API_HOST } from './constants.mjs';
import { signRequest } from './signer.mjs';

export const CREDIT_PATH = '/snap-manager/v1/statistics/plugin';

// 与 CodeArts Agent 26.9.902 对齐（client.go:42-48）。
const PLUGIN_NAME = 'codemate_vscode';
const PLUGIN_VERSION = '26.9.902';
const APP_ID = 'CodeAgent3.0';

const UNAVAILABLE_REASON = '上游未返回积分套餐（可能是 token 套餐、白名单或未开通积分）';

const randomHex = (bytes) => crypto.randomBytes(bytes).toString('hex');

/** 稳定上游会话 ID：同一 accessKeyID 每次相同（Go Session.UpstreamSessionID 等价）。 */
export function sessionIdOf(accessKeyID) {
  const derived = crypto
    .createHash('sha256')
    .update(`codearts-session:${String(accessKeyID ?? '')}`, 'utf8')
    .digest('hex')
    .slice(0, 24);
  return `ses_${derived}`;
}

/** 秒级 UTC ISO（`2006-01-02T15:04:05Z`，与 Go baseHeaders created-time 一致）。 */
function utcIsoSeconds(ms) {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function baseHeaders(cred, nowMs) {
  const traceId = randomHex(16);
  const sessionId = sessionIdOf(cred.accessKeyID);
  return {
    'content-type': 'application/json',
    'app-id': APP_ID,
    'x-ot-function': 'agent-general',
    'x-ot-trace-id': traceId,
    'x-ot-span-id': randomHex(8),
    'x-snap-traceid': `${traceId}_${randomHex(4)}`,
    'x-ot-client-type': 'IDE',
    'x-ot-client-version': PLUGIN_VERSION,
    'plugin-name': PLUGIN_NAME,
    'plugin-version': PLUGIN_VERSION,
    'ide-name': 'VSCode',
    'ide-version': PLUGIN_VERSION,
    'created-time': utcIsoSeconds(nowMs),
    'user-msg-id': `msg_${randomHex(6)}`,
    'x-ot-session-id': sessionId,
    'x-ot-parent-session-id': '',
    'user-session-id': sessionId,
    is_confidential: 'false',
    'X-Language': 'zh-cn',
  };
}

/** 数字归一：空串/缺失/non-finite 一律按“无值”返回 null（上游可选数字可能回 ""）。 */
const numOrNull = (v) => {
  if (v == null) return null;
  if (typeof v !== 'number' && String(v).trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** 需要数字类型的位置（总额/已用/分类行）：无值记 0。 */
const numOrZero = (v) => numOrNull(v) ?? 0;

const firstNonEmpty = (...values) => {
  for (const value of values) {
    const text = String(value ?? '').trim();
    if (text) return text;
  }
  return '';
};

function creditPackageStatus(status) {
  const key = String(status ?? '').trim().toLowerCase();
  switch (key) {
    case 'normal':
      return 'active';
    case 'closed':
      return 'expired';
    case 'freeze':
    case 'frozen':
      return 'frozen';
    case '':
      return 'unknown';
    default:
      return key;
  }
}

function findMetric(metrics, name) {
  if (!Array.isArray(metrics)) return null;
  return metrics.find((metric) => metric?.name === name) ?? null;
}

/** 分类指标 → {total, used, expiring}；指标缺失返回 null（空串按无值算 0）。 */
function creditCategory(metric) {
  if (!metric) return null;
  return {
    total: numOrZero(metric.package_credit_amount),
    used: numOrZero(metric.package_credit_used),
    expiring: numOrZero(metric.package_credit_expiring_amount),
  };
}

/**
 * 统计插件响应 → 稳定快照（credit.go parseCreditInfo :109-160）。
 * 找不到 usageTotalPackageCredit 不算错误：available=false + reason，其余字段尽力解析。
 */
export function parseCreditInfo(raw) {
  let payload;
  try {
    payload = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    throw new Error('积分额度解析失败: not json');
  }
  if (!payload || typeof payload !== 'object') throw new Error('积分额度解析失败: not an object');

  const pkg = payload.package && typeof payload.package === 'object' ? payload.package : {};
  const metrics = Array.isArray(payload.metrics) ? payload.metrics : [];

  const info = {
    available: false,
    reason: '',
    total: 0,
    used: 0,
    remaining: 0,
    percent: 0,
    expiring: 0,
    resetDate: String(payload.end_date ?? '').trim(),
    status: creditPackageStatus(pkg.status),
    packageName: firstNonEmpty(pkg.package_name_cn, pkg.package_name_en),
    specCode: String(pkg.spec_code ?? ''),
    packageUrl: String(pkg.package_url ?? ''),
    isCreditPackage: Boolean(pkg.is_credit_package),
    isTokenPackage: Boolean(pkg.is_token_package),
    basic: creditCategory(findMetric(metrics, 'usageBasicPackageCredit')),
    onDemand: creditCategory(findMetric(metrics, 'usageOnDemandPackageCredit')),
    bonus: creditCategory(findMetric(metrics, 'usageBonusPackageCredit')),
    tokenUsed: 0,
    tokenLimit: 0,
  };

  const totalMetric = findMetric(metrics, 'usageTotalPackageCredit');
  if (!totalMetric) {
    info.reason = UNAVAILABLE_REASON;
    return info;
  }

  info.available = true;
  info.total = numOrZero(totalMetric.package_credit_amount);
  info.used = numOrZero(totalMetric.package_credit_used);
  // 部分套餐只回总额与已用，剩余需要自己算（credit.go:138-143）；remain/"" 也按缺失处理。
  const remain = numOrNull(totalMetric.package_credit_remain);
  info.remaining = Math.max(0, remain == null ? info.total - info.used : remain);
  const value = numOrNull(totalMetric.value);
  if (value != null) {
    info.percent = value;
  } else if (info.total > 0) {
    info.percent = (info.remaining / info.total) * 100;
  }
  info.expiring = numOrZero(totalMetric.package_credit_expiring_amount);

  const tokenMetric = findMetric(metrics, 'usageTokenChatMessages');
  if (tokenMetric) {
    info.tokenUsed = numOrZero(tokenMetric.usage_token_num);
    info.tokenLimit = numOrZero(tokenMetric.package_token_amount);
  }
  return info;
}

/**
 * GET 积分套餐统计（credit.go FetchCreditInfo :92-106）。
 * cred = {accessKeyID, secretAccessKey, securityToken}；请求体为空串。
 * 非 2xx → Error 带 status（`积分额度查询失败 HTTP <status>: <body 前 200>`）。
 * signal 由调用方注入（quota 用 AbortSignal.timeout 封顶），中止错误原样抛出。
 */
export async function fetchCreditInfo({ cred, fetchImpl = fetch, url, signal } = {}) {
  const target = url || `${SNAP_ENGINE_API_HOST}${CREDIT_PATH}`;
  const headers = signRequest(
    { method: 'GET', url: target, headers: baseHeaders(cred, Date.now()), body: '' },
    cred,
  );
  const res = await fetchImpl(target, { method: 'GET', headers, ...(signal ? { signal } : {}) });
  const text = await res.text().catch(() => '');
  if (!res.ok) {
    const err = new Error(`积分额度查询失败 HTTP ${res.status}: ${text.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  return parseCreditInfo(text);
}
