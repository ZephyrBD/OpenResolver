#!/usr/bin/env node
// PAT → 账号文件。走 jobToken 交换 + userinfo，按 userID 去重追加。
// 交换/落账号逻辑在 pools/qoder/onboard.mjs（与面板 /api/onboard/qoder 共用）。
// 用法：node tools/import-qoder.mjs --pat pt-... [--region cn] [--data <dir>]
import path from 'node:path';
import { parseImportArgs } from './import-args.mjs';
import { loadConfig } from '../config.mjs';
import { loadIdentitySeed } from '../pools/qoder/identity.mjs';
import { accountFromPat, persistAccount } from '../pools/qoder/onboard.mjs';

const args = parseImportArgs(process.argv.slice(2));
if (!args.pat || typeof args.pat !== 'string') {
  console.error('用法：node tools/import-qoder.mjs --pat pt-... [--region cn] [--data <dir>]');
  process.exit(1);
}
const region = args.region === 'cn' ? 'cn' : 'global';
const config = loadConfig(process.env);
const dataDir = path.resolve(args.data || config.dataDir);
const target = `${dataDir}/pools/${region === 'cn' ? 'qoder-cn' : 'qoder'}`;
const identitySeed = loadIdentitySeed(dataDir);

console.log(`交换 jobToken（${region}）...`);
let account;
try {
  ({ account } = await accountFromPat(args.pat, region, { identitySeed }));
} catch (err) {
  console.error(`交换失败：${err.message}`);
  process.exit(1);
}
if (!account) {
  console.error('userinfo 未返回 userID，PAT 可能无效或权限不足');
  process.exit(1);
}

const { skipped, accounts } = persistAccount(target, account, { force: args.force });
if (skipped) {
  console.log(`跳过已存在的 userID ${account.userID}（--force 覆盖）`);
  process.exit(0);
}
console.log(`导入 ${region} 账号 ${account.label || account.userID}（machineID=${account.machineID}）`);
console.log(`落盘：${target}/accounts.json（共 ${accounts.length} 个）`);
