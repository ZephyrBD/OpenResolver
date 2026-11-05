#!/usr/bin/env node
import path from 'node:path';
import { loadConfig } from '../config.mjs';
import { loadKeys, saveKeys } from '../auth/store.mjs';
import { createKey } from '../auth/keys.mjs';

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
const dataDir = path.resolve(args.data || config.dataDir);
const file = path.join(dataDir, 'keys.json');
const db = loadKeys(file);

const pools = typeof args.pools === 'string' ? args.pools.split(',').map((s) => s.trim()).filter(Boolean) : [];
const { full, key } = createKey(db, {
  name: args.name || 'default',
  pools,
  tokenQuota: Number(args.quota || 0),
  expiresAt: args['expires-days'] ? Date.now() + Number(args['expires-days']) * 86_400_000 : 0,
});

saveKeys(file, db);

console.log(`已创建密钥 "${key.name}"（id ${key.id}）`);
console.log(`  池白名单：${pools.length ? pools.join(', ') : '全部'}`);
console.log('');
console.log(`  ${full}`);
console.log('');
console.log('⚠ 明文只显示一次，请立刻保存。数据库只存 sha256。');
