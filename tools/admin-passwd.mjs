#!/usr/bin/env node
// 设置/重置面板管理员密码（scrypt N=2^15 落盘 data/admin.json）。
//   node tools/admin-passwd.mjs --password <pw> [--data <dir>]
//   node tools/admin-passwd.mjs                 交互式输入
// admin.json 不存在时 /auth/login 会返回 503 提示先跑本工具。
import path from 'node:path';
import readline from 'node:readline/promises';
import { parseImportArgs } from './import-args.mjs';
import { loadConfig } from '../config.mjs';
import { saveAdmin } from '../panel/admin.mjs';

const args = parseImportArgs(process.argv.slice(2));
const config = loadConfig(process.env);
const dataDir = path.resolve(args.data || config.dataDir);
const file = path.join(dataDir, 'admin.json');

async function askPassword() {
  if (args.password) return args.password;
  if (!process.stdin.isTTY) {
    console.error('用法：node tools/admin-passwd.mjs --password <pw>（或交互式终端直接运行）');
    process.exit(1);
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const pw = await rl.question('设置面板管理员密码：');
  rl.close();
  if (!pw) {
    console.error('密码不能为空');
    process.exit(1);
  }
  return pw;
}

const password = await askPassword();
const admin = saveAdmin(file, { password });
console.log(`已写入 ${file}（scrypt N=${admin.iterations}，salt=${admin.salt.slice(0, 8)}…）`);
console.log('现在可以用该密码登录面板 /auth/login。');
