#!/usr/bin/env node
// Trae SOLO CN 两段式登录 CLI（面板 /api/onboard/trae 走同一套共用逻辑）：
//   node tools/trae-login.mjs --link                    生成登录链接 + pending-login.json
//   node tools/trae-login.mjs --callback "<回调URL>"     解码 → ExchangeToken → GetUserInfo → 落账号
//
// 链接参数与回调/落账号实现在 pools/trae/login-link.mjs（工具与面板共用）。
// 9074 缓解：--link 生成后存 pending，--callback 落账号时取 pending 里那对，不重新生成。

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  accountFromCallback as sharedAccountFromCallback,
  persistAccount as sharedPersist,
  generateLoginLink,
  buildLoginUrl,
} from '../pools/trae/login-link.mjs';

const DATA_DIR = path.resolve(import.meta.dirname, '..', 'data', 'pools', 'trae');
const PENDING_FILE = path.join(DATA_DIR, 'pending-login.json');
const ACCOUNTS_FILE_DIR = DATA_DIR;

export { buildLoginUrl, generateLoginLink };

function readPending(dataDir) {
  const pendingFile = path.join(dataDir, 'pending-login.json');
  try {
    return JSON.parse(fs.readFileSync(pendingFile, 'utf8'));
  } catch {
    throw new Error(`读不到 ${pendingFile}，先跑 node tools/trae-login.mjs --link`);
  }
}

/** 回调 → 账号对象。machine/device id 取 pending（9074 缓解），pending 缺失时报错。 */
export async function accountFromCallback(callbackUrl, { dataDir = DATA_DIR, fetchImpl = fetch, now = Date.now } = {}) {
  const pending = readPending(dataDir);
  return sharedAccountFromCallback(callbackUrl, {
    machineId: pending.machineId,
    deviceId: pending.deviceId,
    fetchImpl,
    now,
  });
}

/** 落账号（追加去重：同 id 覆盖），返回写入后的列表。 */
export function persistAccount(account, { dataDir = DATA_DIR } = {}) {
  return sharedPersist(account, { dataDir });
}

async function main(argv) {
  const [cmd, ...rest] = argv;
  if (cmd === '--link') {
    const { url, machineId, deviceId } = generateLoginLink({ dataDir: DATA_DIR });
    console.log('请在浏览器打开下面的链接，用手机号/验证码登录：\n');
    console.log(`  ${url}\n`);
    console.log('登录成功后浏览器会跳到一个打不开的 127.0.0.1 地址，复制地址栏完整链接，然后跑：');
    console.log('  node tools/trae-login.mjs --callback "<粘贴回调链接>"');
    console.log(`\n（machine/device id 已存 ${PENDING_FILE}：${machineId.slice(0, 8)}…/${deviceId.slice(0, 8)}…）`);
    return;
  }
  if (cmd === '--callback') {
    const callbackUrl = rest[0];
    if (!callbackUrl) {
      console.error('用法：node tools/trae-login.mjs --callback "<回调链接>"');
      process.exitCode = 1;
      return;
    }
    const account = await accountFromCallback(callbackUrl);
    const accounts = persistAccount(account);
    console.log(`已落账号 ${account.id}（昵称：${account.nickname || '未知'}，uid：${account.uid || '未知'}）`);
    console.log(`当前 Trae 账号池共 ${accounts.length} 个账号（${ACCOUNTS_FILE_DIR}/accounts.json）`);
    return;
  }
  console.error('用法：\n  node tools/trae-login.mjs --link\n  node tools/trae-login.mjs --callback "<回调链接>"');
  process.exitCode = 1;
}

// 直接执行时才跑 main（测试 import 时不触发）
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(`[trae-login] ${err?.message || err}`);
    process.exitCode = 1;
  });
}
