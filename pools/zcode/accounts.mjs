import fs from 'node:fs';
import path from 'node:path';

const FILE = 'accounts.json';

/** 读账号池；文件缺失或损坏都当作空池，避免把网关拖死。 */
export function loadAccounts(dir) {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(dir, FILE), 'utf8'));
    return Array.isArray(data) ? data : Array.isArray(data?.accounts) ? data.accounts : [];
  } catch {
    return [];
  }
}

/** 原子写：tmp + rename，避免写一半被读到。 */
export function saveAccounts(dir, accounts) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const target = path.join(dir, FILE);
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(accounts, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, target);
}
