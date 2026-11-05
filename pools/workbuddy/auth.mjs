// 移植自 vendor/wb-whl/codebuddy_proxy/codebuddy_client_demo.py（MIT）：
// login()（:334-407：state 轮询式登录 + /login/account 的 loopGetAccount）、
// refresh()（:417-437：POST /auth/token/refresh，新 auth 整组回写）、
// _unwrap（:206-215：{data:{data:...}} 双层信封）。
//
// 与源码的差异：
// - 轮询循环拆成无副作用的两步（pollLoginAccount 一次探测，不内置 sleep 循环），
//   面板/CLI 各自决定轮询节奏（对齐 VSIX loopGetAccount 的调用面，不改语义）。
// - WB 的 refreshToken 不是轮换即作废（与 Trae 不同），但依然整组原子落盘。
// - 单飞锁结构照抄 pools/trae/auth.mjs（源 pools/qoder/auth.mjs，不 import）。

import crypto from 'node:crypto';
import { EP_AUTH_STATE, EP_AUTH_TOKEN, EP_LOGIN_ACCOUNT, EP_TOKEN_REFRESH } from './constants.mjs';
import { authHeaders, loginHeaders } from './headers.mjs';

export const EXPIRY_BUFFER_MS = 5 * 60_000;
// auth 载荷无 expiresAt 时的续期窗口（wheel ensure_authenticated 对缺失 expiresAt
// 按"长期有效"处理 :438-442；这里收紧为 24h 内不再刷新，超窗续一次保活）。
const DEFAULT_VALIDITY_MS = 24 * 3_600_000;

/** {data:{data:...}} 双层信封 → 内层（_unwrap :206-215）。 */
export function unwrap(payload) {
  if (payload && typeof payload === 'object' && payload.data && typeof payload.data === 'object') {
    if ('data' in payload.data) return payload.data.data;
  }
  if (payload && typeof payload === 'object' && 'data' in payload) return payload.data;
  return payload;
}

function createLoginFlow({ endpoint, fetchImpl = fetch, platform = 'workbuddy' }) {
  // login() :341-348：POST /v2/plugin/auth/state?platform=<platform>，no_auth 头
  return async function flow() {
    const res = await fetchImpl(`${endpoint}${EP_AUTH_STATE}?platform=${encodeURIComponent(platform)}`, {
      method: 'POST',
      headers: loginHeaders({}, { endpoint }),
      body: '{}',
    });
    const text = await res.text().catch(() => '');
    if (!res.ok) throw new Error(`WB auth/state 失败 HTTP ${res.status}: ${text.slice(0, 200)}`);
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error('WB auth/state 响应不是合法 JSON');
    }
    const payload = unwrap(json);
    if (!payload?.authUrl || !payload?.state) {
      throw new Error(`WB 登录状态响应缺少 authUrl/state: ${JSON.stringify(payload)?.slice(0, 200)}`);
    }
    return { state: String(payload.state), loginUrl: String(payload.authUrl) };
  };
}

export { createLoginFlow };

/**
 * 轮询一次登录结果（login() :359-406 的单次迭代）：
 * GET /auth/token?state= → 拿 accessToken → GET /login/account?state=（loopGetAccount）。
 * 未就绪（token 未发 / 账号未同步）返回 null，不抛错——调用方按节奏重试。
 * 成功返回 {account, auth}（wheel :404 _save_session 的 {auth, account} 对）。
 */
export async function pollLoginAccount({ state, region, endpoint, fetchImpl = fetch } = {}) {
  const get = async (path, headers) => {
    const res = await fetchImpl(`${endpoint}${path}?state=${encodeURIComponent(String(state))}`, { headers });
    const text = await res.text().catch(() => '');
    if (!res.ok) return null; // 401/404：账号信息可能尚未就绪（wheel :397-399 continue）
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  };

  const tokenPayload = unwrap(await get(EP_AUTH_TOKEN, loginHeaders({}, { endpoint })));
  const auth = tokenPayload && typeof tokenPayload === 'object' ? tokenPayload : null;
  if (!auth?.accessToken) return null;

  // 关键修复（wheel :372-391）：/login/account 也要轮询。头族以 wheel 为准：
  // enterprise headers（X-Domain）+ Bearer + 三个 X-No-*（无 X-No-Authorization——本请求必须带 Bearer）
  const { 'X-No-Authorization': _drop, ...accountHeaders } = loginHeaders(auth, { endpoint });
  const accountPayload = unwrap(
    await get(EP_LOGIN_ACCOUNT, {
      ...accountHeaders,
      Authorization: `Bearer ${auth.accessToken}`,
    }),
  );
  if (!accountPayload?.uid) return null;
  return { account: accountPayload, auth };
}

/** 账号对象归一（pollLoginAccount 结果 → 池账号）。 */
export function accountFromPoll({ account, auth }) {
  const uid = String(account.uid ?? '');
  return {
    id: `wb-${uid || crypto.randomUUID().slice(0, 8)}`,
    label: String(account.nickname || account.name || uid || 'workbuddy'),
    uid,
    nickname: String(account.nickname ?? ''),
    jwt: String(auth.accessToken),
    refreshToken: String(auth.refreshToken ?? ''),
    domain: auth.domain ? String(auth.domain) : '',
    expiresAt: Number(auth.expiresAt ?? 0) || 0,
    enterpriseId: account.enterpriseId ? String(account.enterpriseId) : '',
    departmentInfo: account.departmentInfo ? String(account.departmentInfo) : '',
    state: 'ok',
    weight: 10,
    enabled: true,
    createdAt: Date.now(),
  };
}

/**
 * refresh（wheel refresh() :417-437）：POST /auth/token/refresh，
 * 头 authHeaders(access:false, refresh:true) + X-Auth-Refresh-Source: plugin，body {}。
 * 返回新 auth 整组（accessToken/refreshToken/expiresAt），由调用方整组落盘。
 */
export async function refreshSession(acc, { endpoint, fetchImpl = fetch, now = Date.now } = {}) {
  if (!acc.refreshToken) return null;
  const res = await fetchImpl(`${endpoint}${EP_TOKEN_REFRESH}`, {
    method: 'POST',
    headers: {
      ...authHeaders(acc, { access: false, refresh: true, endpoint }),
      'X-Auth-Refresh-Source': 'plugin',
    },
    body: '{}',
  });
  const text = await res.text().catch(() => '');
  if (!res.ok) throw new Error(`WB refresh 失败 HTTP ${res.status}: ${text.slice(0, 200)}`);
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error('WB refresh 响应不是合法 JSON');
  }
  const payload = unwrap(json);
  if (!payload || typeof payload !== 'object' || !payload.accessToken) return null;
  return {
    jwt: String(payload.accessToken),
    refreshToken: String(payload.refreshToken ?? acc.refreshToken),
    expiresAt: Number(payload.expiresAt ?? 0) || now() + DEFAULT_VALIDITY_MS,
    domain: payload.domain ? String(payload.domain) : acc.domain || '',
  };
}

/**
 * 单飞 token 管理器（结构同 trae/qoder）：提前 5 分钟刷新，失败重试一次，
 * 再失败返回 null（调用方标 needs_login）。patch 非空时调用方必须整组落盘。
 */
export function createTokenManager({ fetchImpl = fetch, now = Date.now, endpoint } = {}) {
  const inflight = new Map();

  async function doRefresh(acc) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await refreshSession(acc, { endpoint, fetchImpl, now });
      } catch (err) {
        if (attempt === 1) {
          if (process.env.UGW_DEBUG) console.error(`[wb] refresh failed for ${acc.id}: ${err.message}`);
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

  async function accessFor(acc) {
    const expires = acc.expiresAt ?? 0;
    if (acc.jwt && expires && now() < expires - EXPIRY_BUFFER_MS) return { token: acc.jwt, patch: null };
    if (!acc.refreshToken) return { token: acc.jwt || null, patch: null };
    const patch = await refresh(acc);
    if (!patch) return { token: acc.jwt || null, patch: null };
    return { token: patch.jwt, patch };
  }

  return { accessFor, refresh };
}
