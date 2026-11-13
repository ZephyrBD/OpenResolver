// 华为 CodeArts OAuth：PKCE(S256) + DPoP + ticket 轮询登录 + 刷新。
// 移植自 vendor/codearts2api/internal/upstream/client.go（MIT © HITZY2002）：
//   BuildAuthorizeURL :222-236 / ExchangeCode :243-255 / RefreshToken :261-272 /
//   requestToken :291-345（终态失效分类 :309-325）/ PollTicket :348-368 / PKCE :691-700。
//   凭证结构与 DPoP 双绑定语义见 internal/auth/auth.go:15-39。
//
// 与源码的差异：
// - 登录流拆成无副作用的两段（createLoginFlow 只生成状态，pollTicket/exchangeCode
//   各打一次 HTTP），面板 onboard 决定轮询节奏——对齐 WB/trae onboard 模式。
// - 过期时间统一毫秒（credentials.expiration RFC3339 → expiresAtMs）。
// - 单飞锁结构照抄 pools/{trae,workbuddy}/auth.mjs（源 pools/qoder/auth.mjs，不 import）。
// - RefreshTokenExpiredError 语义映射为 {expired:true}：调用方据此标 needs_login，
//   与 5xx 可重试错误分开（client.go:74-79 注释）。

import crypto from 'node:crypto';
import {
  STS_HOST, SNAP_MANAGER_HOST, PORTAL_HOST, CLIENT_ID,
  EP_OAUTH_TOKENS, EP_LOGIN_TICKET, REDIRECT_PATH,
  PLUGIN_NAME, PLUGIN_VERSION,
} from './constants.mjs';
import { LOGIN_CONFIG_DEFAULTS, refreshToken } from './oauth.mjs';

export { LOGIN_CONFIG_DEFAULTS };

export const EXPIRY_BUFFER_MS = 5 * 60_000;

function decodeJsonMaybe(value) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  if (text.startsWith('{')) {
    try {
      return JSON.parse(text);
    } catch {
      /* 继续按 base64 解 */
    }
  }
  for (const encoding of ['base64url', 'base64']) {
    try {
      return JSON.parse(Buffer.from(text, encoding).toString('utf8'));
    } catch {
      /* 换一种编码再试 */
    }
  }
  return null;
}

/**
 * refresh_token JWT → {userId, userName, domainId}。
 * 上游把 user_profile 塞在 JWT 载荷里（字符串化后 base64），身份字段的权威来源是它：
 *   principal_id → userId（目录/福利按此隔离）、account_id → domainId、account_name → userName。
 * 载荷顶层字段（user_id/user_name/domain_id）只作兜底。
 */
export function identityFromRefreshToken(refreshToken) {
  try {
    const parts = String(refreshToken || '').split('.');
    if (parts.length < 2) return null;
    const payload = decodeJsonMaybe(parts[1]);
    if (!payload || typeof payload !== 'object') return null;
    let profile = payload?.user_profile;
    if (typeof profile === 'string') profile = decodeJsonMaybe(profile);
    if (!profile || typeof profile !== 'object') return null;
    const userId = String(profile.principal_id ?? payload?.user_id ?? '');
    const userName = String(profile.account_name ?? payload?.user_name ?? '');
    const domainId = String(profile.account_id ?? payload?.domain_id ?? '');
    if (!userId && !userName && !domainId) return null;
    return { userId, userName, domainId };
  } catch {
    return null;
  }
}

/** TokenResponse → 池账号（auth.go Auth 结构的 JS 对应物；DPoP 私钥随账号持久化）。 */
export function accountFromToken(token, { codeVerifier, dpopJwk } = {}) {
  const c = token.credentials;
  // 上游 token 响应可能不带 user_id（live 账号就是这样）：从 refresh_token JWT 里补。
  const identity = identityFromRefreshToken(token?.refresh_token) || {};
  const userId = String(token.user_id || identity.userId || '');
  const userName = String(token.user_name || identity.userName || '');
  const domainId = String(token.domain_id || identity.domainId || '');
  return {
    id: `ca-${userId || crypto.randomUUID().slice(0, 8)}`,
    label: userName || userId || 'codearts',
    userId,
    userName,
    domainId,
    accessKeyID: String(c.access_key_id ?? ''),
    secretAccessKey: String(c.secret_access_key ?? ''),
    securityToken: String(c.security_token ?? ''),
    expiresAt: expiresAtMsOf(c.expiration),
    refreshToken: String(token.refresh_token ?? ''),
    codeVerifier: String(codeVerifier ?? ''),
    dpopJwk: dpopJwk ?? null,
    state: 'ok',
    weight: 10,
    enabled: true,
    createdAt: Date.now(),
  };
}

// credentials.expiration RFC3339 → 毫秒；缺失按 1h 兜底（STS 临时凭证最短档）。
export function expiresAtMsOf(expiration, now = Date.now()) {
  const ms = expiration ? Date.parse(expiration) : NaN;
  return Number.isFinite(ms) ? ms : now + 3_600_000;
}

/**
 * 单飞 token 管理器（结构同 trae/wb）：提前 5 分钟刷新，失败重试一次。
 * 终态失效（RefreshTokenExpired）与可重试错误分开：返回 {expired:true}，
 * 调用方标 state:'needs_login'，不再无限刷新（client.go:74-79 语义）。
 * patch 非空时调用方必须整组落盘（新 STS 凭证 + 可能轮换的 refresh_token）。
 */
export function createTokenManager({ fetchImpl = fetch, now = Date.now, cfg = LOGIN_CONFIG_DEFAULTS } = {}) {
  const inflight = new Map();

  function patchFromToken(token, acc) {
    const c = token.credentials;
    const patch = {
      accessKeyID: String(c.access_key_id ?? ''),
      secretAccessKey: String(c.secret_access_key ?? ''),
      securityToken: String(c.security_token ?? ''),
      expiresAt: expiresAtMsOf(c.expiration, now()),
      refreshToken: String(token.refresh_token ?? acc.refreshToken ?? ''),
    };
    // 老账号可能从未落过身份字段（userId 空 → 目录键空 → 发现结果被丢弃）：
    // 刷新时顺手从 refresh_token JWT 补齐，只填空值，绝不覆盖已有值。
    const identity = identityFromRefreshToken(token.refresh_token || acc.refreshToken);
    if (identity) {
      if (!acc.userId && identity.userId) patch.userId = identity.userId;
      if (!acc.userName && identity.userName) patch.userName = identity.userName;
      if (!acc.domainId && identity.domainId) patch.domainId = identity.domainId;
      if (!acc.label && identity.userName) patch.label = identity.userName;
    }
    return patch;
  }

  async function doRefresh(acc) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const token = await refreshToken({
          cfg,
          refreshToken: acc.refreshToken,
          codeVerifier: acc.codeVerifier,
          dpopJwk: acc.dpopJwk,
          fetchImpl,
        });
        return patchFromToken(token, acc);
      } catch (err) {
        if (err?.expired) return { expired: true };
        if (attempt === 1) {
          if (process.env.UGW_DEBUG) console.error(`[ca] refresh failed for ${acc.id}: ${err.message}`);
          return null;
        }
      }
    }
    return null;
  }

  async function refresh(acc) {
    const key = String(acc.id ?? acc.userId ?? 'unknown');
    const pending = inflight.get(key);
    if (pending) return pending;
    const promise = doRefresh(acc).finally(() => inflight.delete(key));
    inflight.set(key, promise);
    return promise;
  }

  /** 返回 {cred, patch, expired}：cred = {accessKeyID, secretAccessKey, securityToken}。 */
  async function accessFor(acc) {
    const credOf = (a) => ({
      accessKeyID: a.accessKeyID,
      secretAccessKey: a.secretAccessKey,
      securityToken: a.securityToken,
    });
    if (acc.securityToken && acc.expiresAt && now() < acc.expiresAt - EXPIRY_BUFFER_MS) {
      return { cred: credOf(acc), patch: null, expired: false };
    }
    if (!acc.refreshToken) return { cred: acc.securityToken ? credOf(acc) : null, patch: null, expired: false };
    const patch = await refresh(acc);
    if (!patch || patch.expired) return { cred: null, patch: null, expired: Boolean(patch?.expired) };
    return { cred: credOf(patch), patch, expired: false };
  }

  return { accessFor, refresh };
}
