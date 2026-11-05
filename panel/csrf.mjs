import crypto from 'node:crypto';
import { CSRF_COOKIE } from './admin.mjs';

/**
 * CSRF（文档 §12）：双提交 token（cookie `ugw_csrf` + 头 `x-ugw-csrf`，timingSafeEqual 相等）
 * 叠加 Origin 同源校验。无 Origin 的同源工具请求放行；跨 Origin 一律拒绝。
 */

export function newCsrfToken() {
  return crypto.randomBytes(32).toString('hex');
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a ?? ''));
  const bb = Buffer.from(String(b ?? ''));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

/** Origin 存在时必须与 Host 同源；无 Origin（curl/工具）放行。 */
export function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  const host = req.headers.host || '';
  return origin === `http://${host}` || origin === `https://${host}`;
}

/** 非 GET 面板请求的 CSRF 校验：cookie 与头必须都存在且相等（缺失也拒绝）。 */
export function csrfOk(req, cookies) {
  if (!sameOrigin(req)) return false;
  const cookieToken = cookies[CSRF_COOKIE];
  const headerToken = req.headers['x-ugw-csrf'];
  if (!cookieToken || !headerToken) return false;
  return safeEqual(headerToken, cookieToken);
}
