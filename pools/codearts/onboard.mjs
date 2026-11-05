// CodeArts onboard：授权链接/回调粘贴/ticket 轮询 → 落账号。面板 /api/onboard/codearts
// 与 tools 共用。auth 逻辑在 auth.mjs（client.go 移植），这里只做账号落盘与重导出。

import {
  createLoginFlow,
  exchangeCode,
  pollTicket,
  accountFromToken,
  LOGIN_CONFIG_DEFAULTS,
} from './auth.mjs';
import { loadAccounts, saveAccounts } from '../zcode/accounts.mjs';

export { createLoginFlow, exchangeCode, pollTicket, accountFromToken, LOGIN_CONFIG_DEFAULTS };

/** 落账号（追加去重：同 id 覆盖），返回写入后的列表。 */
export function persistAccount(account, { dataDir } = {}) {
  const accounts = loadAccounts(dataDir).filter((a) => a.id !== account.id);
  accounts.push(account);
  saveAccounts(dataDir, accounts);
  return accounts;
}

/** 从用户粘贴的回调 URL 取 code 与回调端口（portal 回跳 127.0.0.1:port 失败时复制地址栏）。 */
export function parseCallback(callbackUrl) {
  const url = new URL(String(callbackUrl));
  return { code: url.searchParams.get('code') ?? '', port: Number(url.port) || 1455 };
}
