// machineId 复用 fingerprint.mjs deriveId（md5 → UUIDv4 形状），salt 固定 "qoder-machine"：
// 语义对齐 pi-provider-qoder 的 machine id（§14.6）：不读 ~/.qoder，
// seed 存 data/identity/qoder.json（{seed:<32hex>}，首次自动生成，0o600）。

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { deriveId } from '../../fingerprint.mjs';

/** md5("qoder-machine:" + seed) → UUIDv4 形状字符串。 */
export function machineIdFor(seed) {
  return deriveId(seed || '', 'qoder-machine');
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
