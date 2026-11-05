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
import { signDpopProof, newDpopPrivateJwk } from './dpop.mjs';

export const EXPIRY_BUFFER_MS = 5 * 60_000;

export const LOGIN_CONFIG_DEFAULTS = {
  clientId: CLIENT_ID,
  portalHost: PORTAL_HOST,
  snapManager: SNAP_MANAGER_HOST,
  stsHost: STS_HOST,
  redirectPath: REDIRECT_PATH,
  pluginName: PLUGIN_NAME,
  pluginVersion: PLUGIN_VERSION,
};

// ---------------------------------------------------------------- PKCE

/** RFC 7636 附录 B 样例：verifier → challenge（S256）。 */
export function pkceChallenge(verifier) {
  return crypto.createHash('sha256').update(verifier, 'ascii').digest('base64url');
}

/** PKCE 生成（client.go:691-700）：64 随机字节 b64url verifier + S256 challenge。 */
export function createPkce() {
  const verifier = crypto.randomBytes(64).toString('base64url');
  return { codeVerifier: verifier, codeChallenge: pkceChallenge(verifier) };
}

// ---------------------------------------------------------------- 授权 URL

/** BuildAuthorizeURL（client.go:222-236）：portal authorize 链接，query 逐项对齐。 */
export function buildAuthorizeURL(cfg, { ticketId, codeChallenge, port }) {
  const q = new URLSearchParams({
    theme: '2',
    locale: 'zh-cn',
    uri_scheme: cfg.clientId,
    client_id: cfg.clientId,
    port: String(port),
    code_challenge: codeChallenge,
    code_challenge_method: 'SHA-256',
    ticket_id: ticketId,
    'plugin-name': cfg.pluginName,
    'plugin-version': cfg.pluginVersion,
  });
  return `${cfg.portalHost}/authorize?${q.toString()}`;
}

// ---------------------------------------------------------------- token 端点

/** requestToken 的错误分类（client.go:309-325）：refresh 通道的终态失效单独识别。 */
export function isRefreshTokenExpired(status, bodyText) {
  let err = '';
  let code = '';
  let msg = '';
  try {
    const json = JSON.parse(bodyText);
    err = String(json?.error ?? '');
    code = String(json?.error_code ?? '');
    msg = String(json?.error_msg ?? '');
  } catch {
    return false;
  }
  return (
    err === 'invalid_grant' ||
    code.includes('ExpiredRefreshToken') ||
    code.includes('InvalidDPoPHeader') ||
    code.includes('invalid client id') ||
    msg.toLowerCase().includes('has been used')
  );
}

// TokenResponse 凭证归一（client.go:331-343 / :359-366：legacy credential 兼容）。
// 上游 JSON 是 snake_case（Go struct json tags），统一归一为 snake_case 形状。
function credentialsOf(token) {
  const c = token?.credentials;
  if (c?.security_token || c?.securityToken) {
    return {
      access_key_id: c.access_key_id ?? c.accessKeyID ?? '',
      secret_access_key: c.secret_access_key ?? c.secretAccessKey ?? '',
      security_token: c.security_token ?? c.securityToken ?? '',
      expiration: c.expiration ?? '',
    };
  }
  const legacy = token?.credential;
  if (legacy?.securitytoken) {
    return {
      access_key_id: legacy.access ?? '',
      secret_access_key: legacy.secret ?? '',
      security_token: legacy.securitytoken ?? '',
      expiration: legacy.expires_at ?? '',
    };
  }
  return null;
}

async function requestToken({ cfg, form, dpopJwk, fetchImpl }) {
  const url = `${cfg.stsHost}${EP_OAUTH_TOKENS}`;
  const proof = signDpopProof(dpopJwk, url);
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', DPoP: proof },
    body: new URLSearchParams(form).toString(),
  });
  const text = await res.text().catch(() => '');
  if (!res.ok) {
    if (form.grant_type === 'refresh_token' && isRefreshTokenExpired(res.status, text)) {
      const expired = new Error(`refresh_token expired or rejected: http=${res.status} ${text.slice(0, 200)}`);
      expired.expired = true;
      throw expired;
    }
    throw new Error(`codearts oauth2/tokens failed: http=${res.status} ${text.slice(0, 300)}`);
  }
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`parse token response: ${text.slice(0, 200)}`);
  }
  const credentials = credentialsOf(json);
  if (!credentials) throw new Error(`token response missing credentials: ${text.slice(0, 200)}`);
  return { ...json, credentials };
}

/** ExchangeCode（client.go:243-255）：authorization_code + PKCE verifier + DPoP。 */
export async function exchangeCode({ cfg, code, codeVerifier, port, dpopJwk, fetchImpl = fetch }) {
  return requestToken({
    cfg,
    dpopJwk,
    fetchImpl,
    form: {
      client_id: cfg.clientId,
      code,
      code_verifier: codeVerifier,
      grant_type: 'authorization_code',
      redirect_uri: `http://127.0.0.1:${port}${cfg.redirectPath}`,
    },
  });
}

/** RefreshToken（client.go:261-272）：必须用签发时的 DPoP 私钥 + 原 code_verifier。 */
export async function refreshToken({ cfg, refreshToken, codeVerifier, dpopJwk, fetchImpl = fetch }) {
  return requestToken({
    cfg,
    dpopJwk,
    fetchImpl,
    form: {
      client_id: cfg.clientId,
      code_verifier: codeVerifier,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    },
  });
}

// ---------------------------------------------------------------- ticket 轮询

/** PollTicket（client.go:348-368）：snap-manager ticket 兜底通道，legacy 凭证归一。 */
export async function pollTicket({ cfg, ticketId, secret, fetchImpl = fetch }) {
  const url = `${cfg.snapManager}${EP_LOGIN_TICKET}?ticket_id=${encodeURIComponent(ticketId)}&secret=${encodeURIComponent(secret)}`;
  const res = await fetchImpl(url, {
    headers: { 'plugin-name': cfg.pluginName, 'plugin-version': cfg.pluginVersion },
  });
  const text = await res.text().catch(() => '');
  if (!res.ok) throw new Error(`codearts login/ticket failed: http=${res.status} ${text.slice(0, 200)}`);
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error('login/ticket 响应不是合法 JSON');
  }
  const credentials = credentialsOf(json);
  if (!credentials) return null; // 尚未登录完成，调用方按节奏重试
  return { ...json, credentials };
}

// ---------------------------------------------------------------- 登录流（两段式）

/** 未登录完成时 ticket 端点可能回非 JSON/空体：pollTicket 已归一为 null，这里透传。 *//**
 * 两段式第一段：生成 PKCE + DPoP 密钥对 + ticketId/secret 与授权链接。
 * port 只用于拼 redirect_uri（浏览器回调 127.0.0.1:port 失败时用户从地址栏粘回）。
 * 返回值必须整组入 flow 存储（onboard-flows.json）；dpopJwk 泄露即账号泄露。
 */
export function createLoginFlow({ cfg = LOGIN_CONFIG_DEFAULTS, port = 1455 } = {}) {
  const pkce = createPkce();
  const dpopJwk = newDpopPrivateJwk();
  const ticketId = crypto.randomBytes(16).toString('hex');
  const secret = crypto.randomBytes(16).toString('hex');
  return {
    authorizeUrl: buildAuthorizeURL(cfg, { ticketId, codeChallenge: pkce.codeChallenge, port }),
    ticketId,
    secret,
    codeVerifier: pkce.codeVerifier,
    dpopJwk,
    port,
  };
}

// ---------------------------------------------------------------- 账号归一与 token 管理

/**
 * JWT 载荷 / user_profile 解码：base64url 优先，标准 base64 兜底
 * （上游 user_profile 是带 padding 的普通 base64 JSON 字符串），纯 JSON 也兼容。
 * 全部失败返回 null（调用方按「无身份信息」降级，绝不抛）。
 */
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
