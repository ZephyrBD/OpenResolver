/**
 * 面板认证处理块（02 §4 拆分自 api.mjs）：登录/登出/会话校验/改密。
 * 闭包状态经 ctx 穿线，登录限速与会话持久化在 admin.mjs。
 */

import { HttpError } from '../http/errors.mjs';
import { sendJson } from '../http/respond.mjs';
import { readJson, DEFAULT_MAX_BODY_BYTES } from '../http/body.mjs';
import { readJson as readJsonFile } from './store.mjs';
import {
  SESSION_COOKIE,
  createSession,
  sessionOf,
  revokeSession,
  revokeOtherSessions,
  verifyPassword,
  saveAdmin,
  lockRemaining,
  recordLoginFailure,
  clearLoginFailures,
  logLockAttemptOnce,
  logLoginAttempt,
  sessionCookie,
  clearSessionCookie,
  csrfCookie,
  clearCsrfCookie,
} from './admin.mjs';
import { newCsrfToken, csrfOk, sameOrigin } from './csrf.mjs';

export function createAuthHandlers(ctx) {
  const {
    adminFile,
    sessionsFile,
    securityFile,
    loginLogFile,
    sessionTtlMs,
    now,
    config,
    secureCookie,
    clientIp,
  } = ctx;

  function requireSession(cookies) {
    const session = sessionOf(sessionsFile, cookies[SESSION_COOKIE], { now, ttl: sessionTtlMs });
    if (!session) throw new HttpError(401, '未登录或会话已过期', { type: 'authentication_error' });
    return session;
  }

  function loadAdminOr503() {
    const admin = readJsonFile(adminFile);
    if (!admin?.hash) {
      throw new HttpError(503, '面板管理员密码未设置，先运行 node tools/admin-passwd.mjs', { type: 'api_error' });
    }
    return admin;
  }

  async function handleLogin(req, res, cookies) {
    if (!sameOrigin(req)) {
      // 登录没有 token 可双提交，但跨 Origin 依然必须拒绝
      throw new HttpError(403, '跨站请求被拒绝', { type: 'forbidden' });
    }
    const ip = clientIp(req);
    const lockedUntil = lockRemaining(securityFile, ip, { now });
    if (lockedUntil) {
      logLockAttemptOnce(securityFile, loginLogFile, ip, lockedUntil);
      throw new HttpError(429, `失败次数过多，已锁定，请 ${Math.ceil((lockedUntil - now()) / 60_000)} 分钟后再试`, {
        type: 'rate_limit_error',
      });
    }
    const admin = loadAdminOr503();
    const body = await readJson(req, config.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES);
    if (!verifyPassword(admin, body.password)) {
      recordLoginFailure(securityFile, ip, { now });
      logLoginAttempt(loginLogFile, { ip, ok: false, reason: 'bad_password' });
      throw new HttpError(401, '密码错误', { type: 'authentication_error' });
    }
    clearLoginFailures(securityFile, ip);
    const sessionId = createSession(sessionsFile, { now });
    const csrfToken = newCsrfToken();
    res.setHeader('Set-Cookie', [sessionCookie(sessionId, { secure: secureCookie }), csrfCookie(csrfToken, { secure: secureCookie })]);
    logLoginAttempt(loginLogFile, { ip, ok: true, reason: '' });
    return sendJson(res, 200, { ok: true, csrfToken });
  }

  async function handleLogout(req, res, cookies) {
    const session = requireSession(cookies);
    if (req.method !== 'GET' && !csrfOk(req, cookies)) {
      throw new HttpError(403, 'CSRF 校验失败', { type: 'forbidden' });
    }
    revokeSession(sessionsFile, cookies[SESSION_COOKIE]);
    res.setHeader('Set-Cookie', [clearSessionCookie({ secure: secureCookie }), clearCsrfCookie({ secure: secureCookie })]);
    return sendJson(res, 200, { ok: true });
  }

  async function handleAuth(req, res, url, cookies) {
    if (url.pathname === '/auth/login' && req.method === 'POST') return handleLogin(req, res, cookies);
    if (url.pathname === '/auth/logout' && req.method === 'POST') return handleLogout(req, res, cookies);
    if (url.pathname === '/auth/me' && req.method === 'GET') {
      const session = sessionOf(sessionsFile, cookies[SESSION_COOKIE], { now, ttl: sessionTtlMs });
      if (!session) return sendJson(res, 200, { authenticated: false, csrfToken: null });
      return sendJson(res, 200, { authenticated: true, csrfToken: cookies['ugw_csrf'] ?? null });
    }
    if (url.pathname === '/auth/password' && req.method === 'POST') {
      const session = requireSession(cookies);
      if (!csrfOk(req, cookies)) throw new HttpError(403, 'CSRF 校验失败', { type: 'forbidden' });
      const admin = loadAdminOr503();
      const body = await readJson(req, config.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES);
      if (!verifyPassword(admin, body.currentPassword)) {
        throw new HttpError(401, '当前密码不正确', { type: 'authentication_error' });
      }
      if (typeof body.newPassword !== 'string' || !body.newPassword) {
        throw new HttpError(400, 'newPassword 不能为空', { type: 'invalid_request_error' });
      }
      if (body.newPassword.length < 8) throw new HttpError(400, 'newPassword 至少 8 位', { type: 'invalid_request_error' });
      saveAdmin(adminFile, { password: body.newPassword });
      revokeOtherSessions(sessionsFile, cookies[SESSION_COOKIE]);
      return sendJson(res, 200, { ok: true });
    }
    throw new HttpError(404, `${req.method} ${url.pathname} 不存在`, { type: 'not_found_error' });
  }

  return { requireSession, loadAdminOr503, handleAuth };
}
