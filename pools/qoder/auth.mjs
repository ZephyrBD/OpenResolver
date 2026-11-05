// 移植自 qodbuddy2pi/assets/vendor/pi-provider-qoder/dist/index.js :760-849（PAT 交换 / userinfo）、
// :1145-1216（refresh）（MIT）。
//
// 裁决（简报）：源码 :802 交换返回 expires_in 时直接 Date.now()+expires_in（漏乘 1000，是 bug），
// 这里乘 1000 按秒处理；expires_at 字符串仍 Date.parse。refresh 路径源码 :1192 本来就对（乘 1000）。
// 提前 5 分钟过期 buffer；并发刷新用单飞锁（每个账号同时在飞的刷新只有一个）。

import { QODER_OPENAPI_COSY_VERSION, QODER_CLIENT_TYPE } from './cosy.mjs';
import { exchangeUrl, userinfoUrl, refreshUrl, regionConfig } from './region.mjs';

const UA = 'pi-provider-qoder';
const PAT_REFRESH_PREFIX = 'pat';
const EXPIRY_BUFFER_MS = 5 * 60_000;

export function encodePatRefresh(pat, jobRefreshToken, userID, machineID) {
  return [PAT_REFRESH_PREFIX, pat, jobRefreshToken, userID, machineID].join('|');
}

export function decodePatRefresh(refresh) {
  const parts = String(refresh || '').split('|');
  return { pat: parts[1] || '', jobRefreshToken: parts[2] || '', userID: parts[3] || '', machineID: parts[4] || '' };
}

/** PAT → jobToken。返回 {jobToken, jobRefreshToken, expiresAt}（expiresAt 已扣 5min buffer）。 */
export async function exchangeJobToken(pat, mode, { fetchImpl = fetch, now = Date.now, url } = {}) {
  const res = await fetchImpl(url || exchangeUrl(mode), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'User-Agent': UA,
      'Cosy-Version': QODER_OPENAPI_COSY_VERSION,
      'Cosy-ClientType': QODER_CLIENT_TYPE,
    },
    body: JSON.stringify({ personal_token: pat }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Qoder PAT exchange failed: ${res.status} ${res.statusText}. ${text.slice(0, 200)}`);
  }
  const data = await res.json();
  if (!data.token) throw new Error('Qoder PAT exchange returned no job token');
  let expiresAt = now() + 24 * 60 * 60 * 1e3;
  if (data.expires_at) {
    const parsed = Date.parse(data.expires_at);
    if (!Number.isNaN(parsed)) expiresAt = parsed;
  } else if (data.expires_in) {
    expiresAt = now() + data.expires_in * 1e3; // 源码 :802 漏乘 1000，这里修掉
  }
  return { jobToken: data.token, jobRefreshToken: data.refresh_token || '', expiresAt: expiresAt - EXPIRY_BUFFER_MS };
}

export async function fetchUserInfo(jobToken, mode, { fetchImpl = fetch, url } = {}) {
  try {
    const res = await fetchImpl(url || userinfoUrl(mode), {
      headers: {
        Authorization: `Bearer ${jobToken}`,
        Accept: 'application/json',
        'User-Agent': UA,
        'Cosy-Version': QODER_OPENAPI_COSY_VERSION,
        'Cosy-ClientType': QODER_CLIENT_TYPE,
      },
    });
    if (!res.ok) return { userID: '', email: '', name: '' };
    const info = await res.json();
    return { userID: info.id || '', email: info.email || '', name: info.name || info.username || '' };
  } catch {
    return { userID: '', email: '', name: '' };
  }
}

/** PAT 换全套凭证（供 import 工具与池内刷新用）。 */
export async function credentialsFromPat(pat, mode, { machineID, fetchImpl = fetch, now = Date.now, url } = {}) {
  const region = regionConfig(mode);
  const { jobToken, jobRefreshToken, expiresAt } = await exchangeJobToken(pat, mode, { fetchImpl, now, url });
  const { userID, email, name } = await fetchUserInfo(jobToken, mode, { fetchImpl, url });
  return {
    jobToken,
    jobRefreshToken,
    userID,
    email: email || region.userEmailFallback,
    name: name || region.userNameFallback,
    machineID: machineID || '',
    expiresAt,
  };
}

/**
 * access token 过期后的刷新：PAT 账号重新走交换；带 refreshToken 的账号走
 * /algo/api/v3/user/refresh_token。失败返回 null（调用方决定是否标 needs_login）。
 */
export async function refreshAccount(acc, mode, { fetchImpl = fetch, now = Date.now, url } = {}) {
  if (acc.pat) {
    try {
      const refreshed = await credentialsFromPat(acc.pat, mode, { machineID: acc.machineID, fetchImpl, now, url });
      return { ...acc, ...refreshed };
    } catch {
      return null;
    }
  }
  const refreshToken = acc.jobRefreshToken || '';
  if (!refreshToken) return null;
  try {
    const response = await fetchImpl(url || refreshUrl(mode), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${acc.jobToken || ''}`,
        Accept: 'application/json',
        'User-Agent': UA,
      },
      body: JSON.stringify({ refreshToken }),
    });
    if (!response.ok) return null;
    const data = await response.json();
    let expireMs = now() + 30 * 24 * 60 * 60 * 1e3;
    if (data.expires_at) {
      const parsed = Date.parse(data.expires_at);
      if (!Number.isNaN(parsed)) expireMs = parsed;
    } else if (data.expires_in) {
      expireMs = now() + data.expires_in * 1e3;
    }
    return {
      ...acc,
      jobToken: data.token,
      jobRefreshToken: data.refresh_token || refreshToken,
      jobTokenExpiresAt: expireMs - EXPIRY_BUFFER_MS,
    };
  } catch {
    return null;
  }
}

/**
 * 单飞 token 管理器：并发发现过期只允许一个刷新在飞。
 * 返回的 patch（含 jobToken/jobTokenExpiresAt 等）由调用方回写到账号。
 */
export function createTokenManager({ mode, fetchImpl = fetch, now = Date.now, url } = {}) {
  const inflight = new Map();

  async function doRefresh(acc) {
    const refreshed = await refreshAccount(acc, mode, { fetchImpl, now, url });
    if (!refreshed) return null;
    return {
      jobToken: refreshed.jobToken,
      jobRefreshToken: refreshed.jobRefreshToken,
      userID: refreshed.userID || acc.userID,
      email: refreshed.email ?? acc.email,
      name: refreshed.name ?? acc.name,
      machineID: acc.machineID,
      jobTokenExpiresAt: refreshed.expiresAt ?? refreshed.jobTokenExpiresAt,
    };
  }

  async function refresh(acc) {
    const key = String(acc.id ?? acc.userID ?? 'unknown');
    const pending = inflight.get(key);
    if (pending) return pending;
    const promise = doRefresh(acc).finally(() => inflight.delete(key));
    inflight.set(key, promise);
    return promise;
  }

  /** 返回 {token, patch}：patch 非空时调用方必须 updateAccount 回写（含 jobTokenExpiresAt）。 */
  async function accessFor(acc) {
    const expires = acc.jobTokenExpiresAt ?? 0;
    if (acc.jobToken && now() < expires) return { token: acc.jobToken, patch: null };
    if (!acc.pat && !acc.jobRefreshToken) return { token: acc.jobToken || null, patch: null };
    const patch = await refresh(acc);
    return { token: patch?.jobToken ?? null, patch };
  }

  return { accessFor, refresh };
}
