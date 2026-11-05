import crypto from 'node:crypto';

/**
 * 设备指纹稳定派生。
 *
 * ZCode 客户端把设备标识放在 body.metadata.user_id：
 *   {"device_id":"<uuid>","account_uuid":"","session_id":"session_<hex>"}
 * 网关是长驻进程冒充多台设备 —— 全账号共用一个 device_id 会被关联成同一台机器，
 * 每次随机又会让同一账号的指纹来回漂移，两者都是异常特征。
 * 所以按账号确定性派生、且恒定不变。
 */
export function deriveId(uid, salt) {
  const seed = `${salt}:${uid || 'anonymous'}`;
  const h = crypto.createHash('md5').update(seed, 'utf8').digest('hex');
  // 对齐 UUIDv4 形态：第 13 位固定 4，第 17 位固定 a
  const patched = `${h.slice(0, 12)}4${h.slice(13, 16)}a${h.slice(17)}`;
  return `${patched.slice(0, 8)}-${patched.slice(8, 12)}-${patched.slice(12, 16)}-${patched.slice(16, 20)}-${patched.slice(20, 32)}`;
}

export function deviceIdFor(uid) {
  return deriveId(uid, 'machine');
}

/** 每账号一个稳定的「客户端实例」 */
export function sessionIdFor(uid) {
  return `session_${crypto.createHash('sha256').update(`session:${uid}`).digest('hex').slice(0, 32)}`;
}

/** 请求 id：32 位无连字符 hex，每条随机（稳定值会成为网关特征） */
export function requestId() {
  return crypto.randomUUID().replace(/-/g, '');
}

/** 从 JWT 里取 user_id（不校验签名，仅用于派生） */
export function userIdFromJwt(jwt) {
  try {
    return JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString('utf8')).user_id ?? null;
  } catch {
    return null;
  }
}

/** 组 ZCode 要求的 metadata.user_id 字符串 */
export function metadataUserId(uid) {
  return JSON.stringify({
    device_id: deviceIdFor(uid),
    account_uuid: '',
    session_id: sessionIdFor(uid),
  });
}
