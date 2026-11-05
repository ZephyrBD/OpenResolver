#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { userIdFromJwt } from '../fingerprint.mjs';
import { loadAccounts, saveAccounts } from '../pools/zcode/accounts.mjs';
import { loadConfig } from '../config.mjs';

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[key] = true;
    else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const config = loadConfig(process.env);
const source = path.resolve(args.from || 'zcode-accounts.json');
if (!fs.existsSync(source)) {
  console.error('找不到账号文件：' + source);
  console.error('用法：node tools/import-zcode.mjs --from <accounts.json> [--data <dir>] [--force]');
  process.exit(1);
}
const dataDir = path.resolve(args.data || config.dataDir);
const target = path.join(dataDir, 'pools', 'zcode');

const raw = JSON.parse(fs.readFileSync(source, 'utf8'));
const incoming = Array.isArray(raw) ? raw : Array.isArray(raw?.accounts) ? raw.accounts : [];
const existing = loadAccounts(target);
const seen = new Set(existing.map((a) => a.uid));
const added = [];

for (const acc of incoming) {
  if (!acc?.jwt) continue;
  const uid = userIdFromJwt(acc.jwt) || acc.email || acc.label;
  if (!args.force && seen.has(uid)) continue;
  seen.add(uid);
  added.push({
    id: crypto.randomUUID(),
    label: acc.label || acc.email || uid,
    email: acc.email || '',
    realm: acc.realm || 'unknown',
    jwt: acc.jwt,
    zaiAccessToken: acc.zaiAccessToken || '',
    uid,
    enabled: true,
    manualWeight: 10,
    createdAt: Date.now(),
  });
}

saveAccounts(target, [...existing, ...added]);

console.log(`导入 ${added.length} 个，跳过 ${incoming.length - added.length} 个已存在`);
for (const a of added) console.log(`  + ${a.label}  uid=${a.uid}`);
console.log(`落盘：${path.join(target, 'accounts.json')}（源文件只读，未改动）`);
