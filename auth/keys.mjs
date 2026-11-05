import crypto from 'node:crypto';

export const KEY_PREFIX = 'zsk_';
const SECRET_BYTES = 32;

export function hashSecret(secret) {
  return crypto.createHash('sha256').update(String(secret)).digest('hex');
}

export function newSecret() {
  return KEY_PREFIX + crypto.randomBytes(SECRET_BYTES).toString('base64url');
}

/**
 * 签发一条密钥。明文只在这里返回一次，落库只存 sha256。
 * enabledPools 为空数组 = 允许全部池。
 */
export function createKey(db, { name, pools = [], expiresAt = 0, tokenQuota = 0, rpm = 0, ipAllowlist = [] } = {}) {
  const full = newSecret();
  const key = {
    id: crypto.randomUUID(),
    name: String(name || 'default'),
    keyHash: hashSecret(full),
    prefix: full.slice(0, 12),
    createdAt: Date.now(),
    expiresAt,
    tokenQuota,
    usedTokens: 0,
    modelAllowlist: [],
    ipAllowlist,
    enabledPools: pools,
    rpm,
    enabled: true,
  };
  db.keys.push(key);
  return { full, key };
}

/** 命中返回 key 记录；未命中 / 已禁用 / 已过期返回 null。 */
export function findKeyBySecret(db, secret) {
  if (typeof secret !== 'string' || !secret.startsWith(KEY_PREFIX)) return null;
  const hash = hashSecret(secret);
  const key = db.keys.find((k) => k.keyHash === hash);
  if (!key || key.enabled === false) return null;
  if (key.expiresAt && key.expiresAt <= Date.now()) return null;
  return key;
}
