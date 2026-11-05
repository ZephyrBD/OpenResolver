// 移植自 vendor/cpa-trae/trae/upstream/client.go（MIT）：refreshLocked（:283-360，
// ExchangeToken 换发 + refreshToken 轮换 + TokenExpireAt 归一化 normalizeExpiresAt :392-400）、
// OAuthHeaders 调用、GetUserInfo（constants.go EpUserInfo）。回调参数解码对齐
// trae-free-credits/1-traework2api/login.sh（MIT）parse_json_param 的双层 unquote。
//
// 与源码的差异：
// - 不做绑定续期（DeviceInfo + P-256 设备签名，client.go:287-296 boundExchangeLocked），
//   只走 /cloudide 裸换发——简报裁决（粘贴回调式登录本就无设备绑定）。
// - 过期时间统一存毫秒（源码 auth 文件用秒）；提前 5 分钟 buffer 在 accessFor 判定。
// - 单飞锁/重试结构照抄 pools/qoder/auth.mjs（不 import）。
// - 9074 已知坑：登录与对话共用同一对 machine/device id 由 tools/trae-login.mjs 保证。

import { CLIENT_ID, IDE_VERSION, DEFAULT_API_HOST, EP_EXCHANGE, EP_USER_INFO } from './constants.mjs';
import { oauthHeaders } from './headers.mjs';

export const EXPIRY_BUFFER_MS = 5 * 60_000;
const DEFAULT_TOKEN_DURATION_S = 1_209_600; // login.sh 与 client.go:357 的兜底时长

/**
 * 解码登录回调链接 → {refreshToken, userInfo, userJwt, uid, nickname, jwtToken}。
 * parse_qs 已解一层；JSON 参数值可能还带一层 URL 编码（双层 %22），容错再 unquote 一次。
 */
export function decodeCallback(callbackUrl) {
  const qs = new URL(String(callbackUrl)).searchParams;
  const parseJsonParam = (raw) => {
    if (!raw) return null;
    for (const candidate of [raw, decodeURIComponent(raw)]) {
      try {
        const obj = JSON.parse(candidate);
        if (obj && typeof obj === 'object' && !Array.isArray(obj)) return obj;
      } catch {
        // 继续尝试下一层
      }
    }
    return null;
  };
  const userInfo = parseJsonParam(qs.get('userInfo')) ?? {};
  const userJwt = parseJsonParam(qs.get('userJwt')) ?? {};
  const refreshToken = qs.get('refreshToken') || userJwt.RefreshToken || '';
  return {
    refreshToken,
    userInfo,
    userJwt,
    uid: String(userInfo.UserID ?? ''),
    nickname: String(userInfo.ScreenName ?? ''),
    jwtToken: String(userJwt.Token ?? ''),
  };
}

/** TokenExpireAt 归一化为毫秒（client.go:392-400 的 1e12 分界；缺失用 Duration 兜底）。 */
function expiresAtOf(result, nowMs) {
  const at = Number(result?.TokenExpireAt ?? 0);
  if (at > 0) return at > 1e12 ? at : at * 1000;
  const duration = Number(result?.TokenExpireDuration ?? 0);
  if (duration > 0) return nowMs + duration * 1000;
  return nowMs + DEFAULT_TOKEN_DURATION_S * 1000;
}

/** ExchangeToken：refreshToken → {token, refreshToken, expiresAt(ms)}。轮换的 refreshToken 由调用方立即落盘。 */
export async function exchangeToken(refreshToken, { fetchImpl = fetch, now = Date.now, url, clientId = CLIENT_ID } = {}) {
  const res = await fetchImpl(url || `${DEFAULT_API_HOST}${EP_EXCHANGE}`, {
    method: 'POST',
    headers: oauthHeaders(),
    body: JSON.stringify({ ClientID: clientId, RefreshToken: refreshToken, ClientSecret: '-', UserID: '' }),
  });
  const text = await res.text().catch(() => '');
  if (!res.ok) {
    throw new Error(`Trae ExchangeToken failed: ${res.status} ${res.statusText}. ${text.slice(0, 200)}`);
  }
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error('Trae ExchangeToken 响应不是合法 JSON');
  }
  const result = json?.Result ?? {};
  if (!result.Token) throw new Error('Trae ExchangeToken 未返回 Token（refreshToken 可能已失效）');
  return {
    token: result.Token,
    refreshToken: result.RefreshToken || refreshToken,
    expiresAt: expiresAtOf(result, now()),
  };
}

/** GetUserInfo：拿 UserID/ScreenName 确认 token 有效；失败返回空对象（不阻塞登录流）。 */
export async function fetchUserInfo(token, { fetchImpl = fetch, url } = {}) {
  try {
    const res = await fetchImpl(url || `${DEFAULT_API_HOST}${EP_USER_INFO}`, {
      method: 'POST',
      headers: { ...oauthHeaders(), 'x-cloudide-token': token },
      body: JSON.stringify({ ReqSource: 'IDE', IDEVersion: IDE_VERSION }),
    });
    if (!res.ok) return { userID: '', nickname: '', enterpriseId: '' };
    const json = await res.json();
    const u = json?.Result ?? json ?? {};
    return {
      userID: String(u.UserID ?? ''),
      nickname: String(u.ScreenName ?? ''),
      enterpriseId: String(u.EnterpriseID ?? ''),
    };
  } catch {
    return { userID: '', nickname: '', enterpriseId: '' };
  }
}

/**
 * 单飞 token 管理器：并发发现过期只允许一个刷新在飞；刷新失败重试一次，
 * 再失败返回 null（调用方标 state:'needs_login'）。patch 由调用方回写账号
 * 并立即落盘（refreshToken 轮换，tmp+rename 由 accounts 存储层负责）。
 */
export function createTokenManager({ fetchImpl = fetch, now = Date.now, url, clientId = CLIENT_ID, onRefresh } = {}) {
  const inflight = new Map();

  async function doRefresh(acc) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const out = await exchangeToken(acc.refreshToken, { fetchImpl, now, url, clientId });
        return { jwt: out.token, refreshToken: out.refreshToken, expiresAt: out.expiresAt };
      } catch (err) {
        if (attempt === 1) {
          if (process.env.UGW_DEBUG) console.error(`[trae] refresh failed for ${acc.id}: ${err.message}`);
          return null;
        }
      }
    }
    return null;
  }

  async function refresh(acc) {
    const key = String(acc.id ?? acc.uid ?? 'unknown');
    const pending = inflight.get(key);
    if (pending) return pending;
    const promise = doRefresh(acc).finally(() => inflight.delete(key));
    inflight.set(key, promise);
    return promise;
  }

  /** 返回 {token, patch}：patch 非空时调用方必须回写账号并落盘。 */
  async function accessFor(acc) {
    const expires = acc.expiresAt ?? 0;
    if (acc.jwt && now() < expires - EXPIRY_BUFFER_MS) return { token: acc.jwt, patch: null };
    if (!acc.refreshToken) return { token: acc.jwt || null, patch: null };
    const patch = await refresh(acc);
    if (!patch) return { token: null, patch: null };
    onRefresh?.(acc.id, patch);
    return { token: patch.jwt, patch };
  }

  return { accessFor, refresh };
}
