// ZCode 浏览器跳转登录（CLI OAuth 流）：init 拿 authorize_url → 用户浏览器授权 → poll 拿账号。
// 落盘账号形状对齐 data/pools/zcode/accounts.json 既有字段（id/label/email/realm/jwt/zaiAccessToken/uid/...）。

import crypto from 'node:crypto';
import { userIdFromJwt } from '../../fingerprint.mjs';
import { loadAccounts, saveAccounts } from './accounts.mjs';

/** 第一步：创建登录流，返回给面板的 authorizeUrl + 面板自己持有的 pollToken。 */
export async function createLoginFlow({ origin = 'https://zcode.z.ai', appVersion = '3.16.3', fetchImpl = fetch, now = Date.now } = {}) {
  const pollToken = crypto.randomBytes(32).toString('hex');
  const res = await fetchImpl(`${origin}/api/v1/oauth/cli/init`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${pollToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ provider: 'zai' }),
  });
  const env = await res.json();
  if (env.code !== 0) throw new Error(env.msg || `zcode cli/init failed (${res.status})`);
  const data = env.data || {};
  return {
    flowId: data.flow_id,
    authorizeUrl: data.authorize_url,
    expiresAt: data.expires_at,
    pollIntervalSec: data.poll_interval_sec,
    pollToken,
    createdAt: now(),
  };
}

/** 第二步：轮询。202/404 或 data.status==='pending' → {status:'pending'}；ready → 账号。 */
export async function pollLogin({ origin, flowId, pollToken, fetchImpl = fetch, now = Date.now } = {}) {
  const res = await fetchImpl(`${origin}/api/v1/oauth/cli/poll/${encodeURIComponent(flowId)}`, {
    headers: { authorization: `Bearer ${pollToken}` },
  });
  const env = await res.json().catch(() => ({}));
  if (res.status === 202 || res.status === 404 || env?.data?.status === 'pending') {
    return { status: 'pending' };
  }
  if (env.code !== 0) throw new Error(env.msg || `zcode cli/poll failed (${res.status})`);
  const data = env.data || {};
  if (data.status === 'ready') {
    return { status: 'ready', account: accountFromPoll(data, { now }), raw: data };
  }
  return { status: data.status };
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
