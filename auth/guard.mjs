import { findKeyBySecret } from './keys.mjs';

export class AuthError extends Error {
  constructor(status, message, { type = 'authentication_error', code = '' } = {}) {
    super(message);
    this.name = 'AuthError';
    this.status = status;
    this.type = type;
    this.code = code;
  }
}

export function extractSecret(headers = {}) {
  const auth = headers.authorization;
  if (typeof auth === 'string' && /^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i, '').trim();
  const key = headers['x-api-key'];
  if (typeof key === 'string' && key.trim()) return key.trim();
  return null;
}

export function normalizeIp(ip) {
  return String(ip || '').replace(/^::ffff:/, '');
}

export function isLoopback(ip) {
  const v = normalizeIp(ip);
  return v === '::1' || v === 'localhost' || v.startsWith('127.');
}

function v4ToInt(ip) {
  const parts = String(ip).split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    const b = Number(p);
    if (!Number.isInteger(b) || b < 0 || b > 255 || p === '') return null;
    n = (n << 8) | b;
  }
  return n >>> 0;
}

export function ipAllowed(ip, allowlist = []) {
  if (!allowlist.length) return true;
  const target = normalizeIp(ip);
  return allowlist.some((entry) => {
    const e = normalizeIp(entry);
    if (e === target) return true;
    const slash = e.indexOf('/');
    if (slash < 0) return false;
    const base = v4ToInt(e.slice(0, slash));
    const addr = v4ToInt(target);
    const bits = Number(e.slice(slash + 1));
    if (base === null || addr === null || !Number.isInteger(bits) || bits < 0 || bits > 32) return false;
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    return (base & mask) === (addr & mask);
  });
}

/**
 * 校验一条推理请求。通过返回 { key }；openMode 放行时 key 为 null。
 * 池 / 模型 / IP 白名单为空 = 不限制。
 */
export function authorize({ secret, ip, db, config = {}, pool, model }) {
  if (!secret) {
    if (config.openMode !== false && isLoopback(ip)) return { key: null, openMode: true };
    throw new AuthError(401, '缺少 API key（zsk_…），请用 Authorization: Bearer 或 x-api-key 传入');
  }

  const key = findKeyBySecret(db, secret);
  if (!key) throw new AuthError(401, 'API key 无效、已禁用或已过期');

  if (Array.isArray(key.enabledPools) && key.enabledPools.length && pool && !key.enabledPools.includes(pool)) {
    throw new AuthError(403, `该密钥不允许访问池 "${pool}"`, { type: 'permission_error' });
  }
  if (Array.isArray(key.modelAllowlist) && key.modelAllowlist.length && model && !key.modelAllowlist.includes(model)) {
    throw new AuthError(403, `该密钥不允许使用模型 "${model}"`, { type: 'permission_error' });
  }
  if (Array.isArray(key.ipAllowlist) && key.ipAllowlist.length && !ipAllowed(ip, key.ipAllowlist)) {
    throw new AuthError(403, `来源 IP ${ip} 不在该密钥的白名单内`, { type: 'permission_error' });
  }
  if (key.tokenQuota > 0 && key.usedTokens >= key.tokenQuota) {
    throw new AuthError(403, '密钥 token 配额已用尽', { type: 'permission_error', code: 'quota_exceeded' });
  }

  return { key };
}
