// machineIdFor 移植自 fingerprint.mjs deriveId（md5 → UUIDv4 形状），
// 语义对齐 pi-provider-qoder 的 machine id（§14.6）：不读 ~/.qoder，
// seed 存 data/identity/qoder.json（{seed:<32hex>}，首次自动生成，0o600）。

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** md5("qoder-machine:" + seed) → UUIDv4 形状字符串。 */
export function machineIdFor(seed) {
  const h = crypto.createHash('md5').update(`qoder-machine:${seed || ''}`, 'utf8').digest('hex');
  const patched = `${h.slice(0, 12)}4${h.slice(13, 16)}a${h.slice(17)}`;
  return `${patched.slice(0, 8)}-${patched.slice(8, 12)}-${patched.slice(12, 16)}-${patched.slice(16, 20)}-${patched.slice(20, 32)}`;
}

/** 每账号一个稳定 machineID：全局 seed + 账号 id 再派生。 */
export function machineIdForAccount(identitySeed, accountId) {
  return machineIdFor(`${identitySeed}:${accountId}`);
}

/** 读（或生成）全局 identity seed 文件。 */
export function loadIdentitySeed(dataDir) {
  const dir = path.join(dataDir, 'identity');
  const file = path.join(dir, 'qoder.json');
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (typeof data?.seed === 'string' && data.seed) return data.seed;
  } catch {
    // 首次生成
  }
  const seed = crypto.randomBytes(16).toString('hex');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify({ seed }, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
  return seed;
}
