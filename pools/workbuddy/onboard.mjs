// WorkBuddy onboard：登录链接 → state 轮询 → 落账号。tools 与面板 /api/onboard/workbuddy 共用。
// auth 逻辑在 auth.mjs（wheel :334-437 移植），这里只做账号落盘与重导出。

import { createLoginFlow, pollLoginAccount, accountFromPoll } from './auth.mjs';
import { loadAccounts, saveAccounts } from '../zcode/accounts.mjs';

export { createLoginFlow, pollLoginAccount, accountFromPoll };

/** 落账号（追加去重：同 id 覆盖），返回写入后的列表。 */
export function persistAccount(account, { dataDir } = {}) {
  const accounts = loadAccounts(dataDir).filter((a) => a.id !== account.id);
  accounts.push(account);
  saveAccounts(dataDir, accounts);
  return accounts;
}
