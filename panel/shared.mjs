/**
 * 面板后端共享件（02 §4 拆分自 api.mjs）：安全响应头、视图整形、运行态账号构造。
 * 纯函数 / 常量，不含闭包状态——有状态的处理在 api.mjs 工厂内。
 */

import { HttpError } from '../http/errors.mjs';
import { deviceIdFor, sessionIdFor } from '../core/fingerprint.mjs';

const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:",
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};

const FLOW_TTL_MS = 10 * 60_000;
const SENSITIVE_FIELDS = ['jwt', 'refreshToken', 'pat', 'jobToken', 'jobRefreshToken'];
const ACCOUNT_PATCH_FIELDS = ['label', 'manualWeight', 'enabled', 'captcha'];

function clampManual(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 10;
  return Math.min(20, Math.max(0, n));
}

/** claimer.status 的字段形状映射（对齐 zcode/claim.mjs / trae/checkin.mjs：checkedIn/credits/message/details）。 */
function claimerCheckinOf(st) {
  const out = {
    checkedIn: st?.checkedIn === true,
    credits: Number(st?.credits) || 0,
    message: st?.message ?? '',
    supported: st?.supported === true,
  };
  const streakDays = Number(st?.details?.streakDays ?? st?.streakDays);
  if (Number.isFinite(streakDays)) out.streakDays = streakDays;
  if (typeof st?.details?.active === 'boolean') out.active = st.details.active;
  return out;
}

function safeDecode(v) {
  try {
    return decodeURIComponent(v);
  } catch {
    throw new HttpError(400, 'URL 编码非法', { type: 'invalid_request_error' });
  }
}

function poolByName(pools, name) {
  if (!/^[a-z0-9-]+$/.test(name || '')) throw new HttpError(404, `未知池 "${name}"`, { type: 'not_found_error' });
  const pool = pools.find((p) => p.name === name);
  if (!pool) throw new HttpError(404, `未知池 "${name}"`, { type: 'not_found_error' });
  return pool;
}

/** 各池把 base 调度器包在 `.scheduler` 子对象里（snapshot/settings/patchSettings/updateAccount 在其上）。 */
function sched(pool) {
  return pool.scheduler ?? pool;
}

/** 凭证只回显尾 4 位；敏感字段绝不出现在面板响应里。 */
export function accountView(acc) {
  const view = {
    id: acc.id,
    label: acc.label ?? '',
    enabled: acc.enabled,
    state: acc.state ?? 'ok',
    manualWeight: acc.manualWeight,
    weight: acc.weight ?? acc.manualWeight ?? 10,
    email: acc.email ?? '',
    userID: acc.userID ?? '',
    uid: acc.uid ?? '',
    nickname: acc.nickname ?? '',
    machineID: acc.machineID ?? acc.machineId ?? '',
    deviceId: acc.deviceId ?? '',
    expiresAt: acc.expiresAt ?? 0,
    jobTokenExpiresAt: acc.jobTokenExpiresAt ?? 0,
    createdAt: acc.createdAt ?? 0,
    lastUsedAt: acc.lastUsedAt ?? 0,
    inFlight: acc.inFlight ?? 0,
    cooldownUntil: acc.cooldownUntil ?? 0,
    cooldownRemainingMs: Math.max(0, (acc.cooldownUntil ?? 0) - Date.now()),
    cooldownKind: acc.cooldownKind ?? null,
    consecutiveFails: acc.consecutiveFails ?? 0,
    quotaRatio: typeof acc.quotaRatio === 'number' ? acc.quotaRatio : null,
    // ZCode 验证码参数存在账号上（3007 时人工补），面板回显便于确认是否已填
    captcha: acc.captcha ? `***${String(acc.captcha).slice(-4)}` : '',
  };
  for (const field of SENSITIVE_FIELDS) {
    if (acc[field]) view[field] = `***${String(acc[field]).slice(-4)}`;
  }
  return view;
}

/** 名称主显示：label → nickname → email → id（面板用它做主标识，id 退居次级）。 */
export function displayNameOf(acc) {
  return String(acc?.label || acc?.nickname || acc?.email || acc?.id || '');
}

function keyView(key) {
  // keyHash 不回显：面板只需要元数据
  return {
    id: key.id,
    name: key.name,
    prefix: key.prefix,
    createdAt: key.createdAt,
    expiresAt: key.expiresAt,
    tokenQuota: key.tokenQuota,
    usedTokens: key.usedTokens,
    rpm: key.rpm,
    ipAllowlist: key.ipAllowlist,
    enabledPools: key.enabledPools,
    enabled: key.enabled,
  };
}

/**
 * 运行态账号对象（对齐 pools/base.mjs runtimeOf 的字段）：pick/weightOf/snapshot 依赖
 * inFlight/outcomes 等字段，直接 push 裸账号对象会坏调度。
 */
function runtimeAccount(pool, account) {
  const acc = {
    ...account,
    id: account.id,
    manualWeight: clampManual(account.manualWeight ?? account.weight ?? 10),
    enabled: account.enabled !== false && account.enabled !== 0,
    state: account.state ?? 'ok',
    inFlight: 0,
    cooldownUntil: 0,
    cooldownKind: null,
    consecutiveFails: 0,
    lastUsedAt: account.lastUsedAt ?? 0,
    outcomes: [],
  };
  if (pool.name === 'zcode' && (!acc.deviceId || !acc.sessionId) && acc.uid != null) {
    acc.deviceId = acc.deviceId || deviceIdFor(acc.uid);
    acc.sessionId = acc.sessionId || sessionIdFor(acc.uid);
  }
  return acc;
}

/** 运行态与磁盘同步：同 id 先删再插（新增/覆盖），返回插入后的运行态对象。 */
function upsertRuntimeAccount(pool, account) {
  const idx = pool.accounts.findIndex((a) => a.id === account.id);
  if (idx >= 0) pool.accounts.splice(idx, 1);
  const acc = runtimeAccount(pool, account);
  pool.accounts.push(acc);
  return acc;
}

export { clampManual, claimerCheckinOf, safeDecode, poolByName, sched, keyView, runtimeAccount, upsertRuntimeAccount, SECURITY_HEADERS, SENSITIVE_FIELDS, ACCOUNT_PATCH_FIELDS, FLOW_TTL_MS };
