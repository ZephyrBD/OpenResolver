import { exchangeJobToken, fetchUserInfo } from './auth.mjs';
import { machineIdForAccount } from './identity.mjs';
import { loadAccounts, saveAccounts } from '../zcode/accounts.mjs';

/**
 * Qoder PAT → 账号，tools/import-qoder.mjs 与面板 /api/onboard/qoder 共用。
 * 交换与 userinfo 的 URL 分开注入（面板测试要分别打桩）。
 */
export async function accountFromPat(
  pat,
  mode,
  { identitySeed, fetchImpl = fetch, now = Date.now, exchangeUrl, userinfoUrl } = {},
) {
  const { jobToken, jobRefreshToken, expiresAt } = await exchangeJobToken(pat, mode, { fetchImpl, now, url: exchangeUrl });
  const info = await fetchUserInfo(jobToken, mode, { fetchImpl, url: userinfoUrl });
  if (!info.userID) return { creds: info, account: null };
  const machineID = machineIdForAccount(identitySeed, info.userID);
  const account = {
    id: `q-${info.userID.slice(0, 8)}`,
    label: info.name || '',
    email: info.email || '',
    pat,
    jobToken,
    jobRefreshToken: jobRefreshToken || '',
    userID: info.userID,
    machineID,
    jobTokenExpiresAt: expiresAt,
    weight: 10,
    enabled: true,
    createdAt: Date.now(),
  };
  return { creds: info, account };
}

/** 按 userID 去重落盘：已存在且 !force 返回 skipped；force 时覆盖同 userID 的旧账号。 */
export function persistAccount(target, account, { force = false } = {}) {
  const existing = loadAccounts(target);
  if (existing.some((a) => a.userID === account.userID && !force)) {
    return { skipped: true, accounts: existing };
  }
  const accounts = [...existing.filter((a) => a.userID !== account.userID), account];
  saveAccounts(target, accounts);
  return { skipped: false, accounts };
}
