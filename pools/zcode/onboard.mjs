// ZCode 浏览器跳转登录（CLI OAuth 流）：init 拿 authorize_url → 用户浏览器授权 → poll 拿账号。
// 落盘账号形状对齐 data/pools/zcode/accounts.json 既有字段（id/label/email/realm/jwt/zaiAccessToken/uid/...）。

import crypto from 'node:crypto';
import { userIdFromJwt } from '../../core/fingerprint.mjs';
import { loadAccounts, saveAccounts } from './accounts.mjs';
import { ZCODE_ORIGIN, ZCODE_APP_VERSION } from './constants.mjs';

/**
 * 把 authorize_url 的 redirect 参数改写为 ZCode 客户端回跳地址（移植 zcode_login.py apply_interstitial）。
 * 不改写时上游授权页找不到 CLI 回跳，授权完成后 flow 永远不会 ready，面板只能一直 pending 到 10 分钟超时。
 * cn 用 redirect=，intl 用 redirect_uri= 参数名。
 */
export function applyInterstitial(authorizeUrl, region = 'intl', { origin = ZCODE_ORIGIN, appVersion = ZCODE_APP_VERSION } = {}) {
  const param = region === 'cn' ? 'redirect' : 'redirect_uri';
  const target = encodeURIComponent(`${origin}/app/oauth/login?redirect=${encodeURIComponent('zcode://oauth/callback')}&app_version=${appVersion}`);
  const [head, fragment] = authorizeUrl.split('#');
  const [path, query] = head.split('?');
  if (!query) return authorizeUrl;
  const prefix = `${param}=`;
  let replaced = false;
  const segments = [];
  for (const seg of query.split('&').filter(Boolean)) {
    if (!seg.startsWith(prefix)) {
      segments.push(seg);
    } else if (!replaced) {
      segments.push(`${prefix}${target}`);
      replaced = true;
    }
  }
  return `${path}?${segments.join('&')}${fragment !== undefined ? `#${fragment}` : ''}`;
}

/** 第一步：创建登录流，返回给面板的 authorizeUrl + 面板自己持有的 pollToken。 */
export async function createLoginFlow({ origin, appVersion, region = 'intl', fetchImpl = fetch, now = Date.now } = {}) {
  const base = origin || ZCODE_ORIGIN;
  const pollToken = crypto.randomBytes(32).toString('hex');
  const res = await fetchImpl(`${base}/api/v1/oauth/cli/init`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${pollToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ provider: region === 'cn' ? 'bigmodel' : 'zai' }),
  });
  const env = await res.json();
  if (env.code !== 0) throw new Error(env.msg || `zcode cli/init failed (${res.status})`);
  const data = env.data || {};
  return {
    flowId: data.flow_id,
    authorizeUrl: applyInterstitial(data.authorize_url, region, { origin: base, appVersion: appVersion || ZCODE_APP_VERSION }),
    expiresAt: data.expires_at,
    pollIntervalSec: data.poll_interval_sec,
    pollToken,
    createdAt: now(),
  };
}

/**
 * 第二步：轮询。对齐上游真实契约（参考 ZCode-Daily/zcode_login.py poll_once）：
 * - 5xx / 408 / 429 / 202 / 404 / 无 data 对象 / status!=ready → pending（网络抖动不该打断面板轮询）；
 * - status==='failed' → 抛「授权被拒绝或已失效」；
 * - code!==0 → 抛上游 msg；
 * - ready → 账号。
 * 旧实现只看 202/404，上游 200+空 data 或 5xx 会被当成终态直接报错，这就是登录后卡死/报错的主因。
 */
export async function pollLogin({ origin, flowId, pollToken, fetchImpl = fetch, now = Date.now } = {}) {
  const res = await fetchImpl(`${origin}/api/v1/oauth/cli/poll/${encodeURIComponent(flowId)}`, {
    headers: { authorization: `Bearer ${pollToken}` },
  });
  if (res.status >= 500 || res.status === 408 || res.status === 429) return { status: 'pending' };
  const env = await res.json().catch(() => ({}));
  if (res.status === 202 || res.status === 404 || env?.data?.status === 'pending') {
    return { status: 'pending' };
  }
  if (env.code !== 0 && env.code != null) {
    throw new Error(env.msg || env.message || `zcode cli/poll failed (${res.status})`);
  }
  if (res.status >= 400) throw new Error(`zcode cli/poll rejected (HTTP ${res.status})`);
  const data = env.data;
  if (!data || typeof data !== 'object') return { status: 'pending' };
  if (data.status === 'failed') throw new Error('ZCode 授权被拒绝或已失效，请重新生成登录链接');
  if (data.status === 'ready') {
    return { status: 'ready', account: accountFromPoll(data, { now }), raw: data };
  }
  return { status: data.status || 'pending' };
}

/** poll 结果 → 既有 zcode 账号形状。realm：手机号形态（1\d{10} 或 @phone.local）视为 cn。 */
export function accountFromPoll(data, { now = Date.now } = {}) {
  const jwt = data.token;
  const uid = userIdFromJwt(jwt) || data.user?.user_id || '';
  if (!uid) throw new Error('zcode poll 结果无法派生 uid（jwt 无 user_id 且缺 user.user_id）');
  const nick = data.nick ?? data.user?.nick ?? '';
  const email = data.email ?? data.user?.email ?? '';
  const phone = data.phone ?? data.user?.phone ?? '';
  const isCn = [email, phone].some((v) => /^1\d{10}$/.test(v) || v.endsWith('@phone.local'));
  return {
    id: crypto.randomUUID(),
    label: nick ? `${nick}-${uid.slice(0, 8)}` : uid.slice(0, 8),
    email,
    phone,
    realm: isCn ? 'cn' : 'unknown',
    jwt,
    zaiAccessToken: data.zai?.access_token || data.zai?.accessToken || '',
    uid,
    enabled: true,
    manualWeight: 10,
    createdAt: now(),
  };
}

/** 按 uid 去重落盘：已存在同 uid 返回 skipped；否则替换/追加并原子保存。 */
export function persistAccount(dir, account) {
  const existing = loadAccounts(dir);
  if (existing.some((a) => a.uid === account.uid)) {
    return { skipped: true, accounts: existing };
  }
  const accounts = [...existing.filter((a) => a.uid !== account.uid), account];
  saveAccounts(dir, accounts);
  return { skipped: false, accounts };
}
