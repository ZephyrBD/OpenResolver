/**
 * 华为 CodeArts OAuth 交换层（02 §4 拆分自 auth.mjs）：PKCE/DPoP 签名交换、
 * ticket 轮询、两段式登录流。账号归一与 token 管理在 auth.mjs。
 */

import crypto from 'node:crypto';
import {
  STS_HOST, SNAP_MANAGER_HOST, PORTAL_HOST, CLIENT_ID,
  EP_OAUTH_TOKENS, EP_LOGIN_TICKET, REDIRECT_PATH,
  PLUGIN_NAME, PLUGIN_VERSION,
} from './constants.mjs';
import { signDpopProof, newDpopPrivateJwk } from './dpop.mjs';

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
