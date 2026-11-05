import crypto from 'node:crypto';
import fs from 'node:fs';
import { readJson, writeJson, appendJsonl } from './store.mjs';

/**
 * 管理员认证（文档 §12）：scrypt 密码、会话（7 天滑动）、登录限速、登录日志。
 * 全部 node:crypto 原语；文件一律 tmp+rename 原子写。
 */

export const SCRYPT_N = 2 ** 15;
export const SESSION_TTL_MS = 7 * 24 * 3_600_000;
export const SESSION_COOKIE = 'ugw_session';
export const CSRF_COOKIE = 'ugw_csrf';
export const FAIL_WINDOW_MS = 10 * 60_000;
export const FAIL_LIMIT = 10;
export const LOCK_MS = 15 * 60_000;

const SCRYPT_MAXMEM = 128 * 1024 * 1024; // N=2^15, r=8 需要 32MB，Node 默认 maxmem 32MB 会炸

export function hashPassword(password, { salt = crypto.randomBytes(16).toString('hex'), iterations = SCRYPT_N } = {}) {
  const hash = crypto.scryptSync(String(password), salt, 64, { N: iterations, r: 8, p: 1, maxmem: SCRYPT_MAXMEM }).toString('hex');
  return { salt, hash, iterations };
}

export function verifyPassword(admin, password) {
  if (!admin?.salt || !admin?.hash || typeof password !== 'string') return false;
  const calc = crypto.scryptSync(password, admin.salt, 64, {
    N: admin.iterations || SCRYPT_N,
    r: 8,
    p: 1,
    maxmem: SCRYPT_MAXMEM,
  });
  const stored = Buffer.from(admin.hash, 'hex');
  return stored.length === calc.length && crypto.timingSafeEqual(stored, calc);
}

export function saveAdmin(file, { password, iterations } = {}) {
  const admin = hashPassword(password, iterations ? { iterations } : {});
  writeJson(file, admin);
  return admin;
}

// ---- 会话 ----

function loadSessions(file) {
  const db = readJson(file, null);
  return db && typeof db.sessions === 'object' && db.sessions ? db : { sessions: {} };
}

export function createSession(file, { now = Date.now } = {}) {
  const db = loadSessions(file);
  const id = crypto.randomBytes(32).toString('hex');
  db.sessions[id] = { createdAt: now(), lastSeenAt: now() };
  writeJson(file, db);
  return id;
}

const SESSION_TOUCH_INTERVAL_MS = 60_000;

/** 命中返回会话并滑动续期；过期即删除。续期落盘限频（60s），避免每请求都写 sessions.json。 */
export function sessionOf(file, id, { now = Date.now, ttl = SESSION_TTL_MS } = {}) {
  if (!id || typeof id !== 'string') return null;
  const db = loadSessions(file);
  const session = db.sessions[id];
  if (!session) return null;
  const t = now();
  if (t - session.lastSeenAt > ttl) {
    delete db.sessions[id];
    writeJson(file, db);
    return null;
  }
  if (t - session.lastSeenAt > SESSION_TOUCH_INTERVAL_MS) {
    session.lastSeenAt = t;
    writeJson(file, db);
  }
  return session;
}

export function revokeSession(file, id) {
  if (!id) return;
  const db = loadSessions(file);
  if (db.sessions[id]) {
    delete db.sessions[id];
    writeJson(file, db);
  }
}

/** 改密后吊销其它会话（保留当前）。 */
export function revokeOtherSessions(file, keepId) {
  const db = loadSessions(file);
  const before = Object.keys(db.sessions).length;
  for (const id of Object.keys(db.sessions)) {
    if (id !== keepId) delete db.sessions[id];
  }
  if (Object.keys(db.sessions).length !== before) writeJson(file, db);
}

// ---- 登录限速（data/security.json 持久化） ----

function loadSecurity(file) {
  const db = readJson(file, null);
  return {
    fails: db && typeof db.fails === 'object' && db.fails ? db.fails : {},
    lockedUntil: db && typeof db.lockedUntil === 'object' && db.lockedUntil ? db.lockedUntil : {},
    lockLogged: db && typeof db.lockLogged === 'object' && db.lockLogged ? db.lockLogged : {},
  };
}

/** 返回锁的到期时间戳；0 = 未锁。 */
export function lockRemaining(file, ip, { now = Date.now } = {}) {
  const db = loadSecurity(file);
  const until = db.lockedUntil[ip] || 0;
  if (until <= now()) return 0;
  return until;
}

/** 记一次失败；达到阈值（窗口内 FAIL_LIMIT 次）上锁 LOCK_MS 并清空失败计数。返回锁到期时间（0=未锁）。 */
export function recordLoginFailure(file, ip, { now = Date.now } = {}) {
  const db = loadSecurity(file);
  const t = now();
  db.fails[ip] = (db.fails[ip] || []).filter((ts) => t - ts < FAIL_WINDOW_MS);
  db.fails[ip].push(t);
  let lockedUntil = 0;
  if (db.fails[ip].length >= FAIL_LIMIT) {
    lockedUntil = t + LOCK_MS;
    db.lockedUntil[ip] = lockedUntil;
    delete db.fails[ip];
  }
  writeJson(file, db);
  return lockedUntil;
}

export function clearLoginFailures(file, ip) {
  const db = loadSecurity(file);
  if (db.fails[ip] || db.lockLogged?.[ip]) {
    delete db.fails[ip];
    if (db.lockLogged) delete db.lockLogged[ip];
    writeJson(file, db);
  }
}

/**
 * 锁定期内的重复尝试不重复写登录日志（防刷大 jsonl）：同一把锁（lockedUntil 相同）只记一条。
 * 锁解除后（clearLoginFailures 或换新锁）恢复可记，locked→解锁的转变自然落在正常路径的日志里。
 */
export function logLockAttemptOnce(securityFile, logFile, ip, lockedUntil) {
  const db = loadSecurity(securityFile);
  db.lockLogged = db.lockLogged ?? {};
  if (db.lockLogged[ip] === lockedUntil) return;
  db.lockLogged[ip] = lockedUntil;
  writeJson(securityFile, db);
  logLoginAttempt(logFile, { ip, ok: false, reason: 'locked' });
}

// ---- 登录日志 ----

export function logLoginAttempt(file, { ip, ok, reason = '' }) {
  appendJsonl(file, { ts: Date.now(), ip, ok, reason });
}

/** 尾部 n 条（/api/logs 用）。 */
export function readLoginLog(file, n = 200) {
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  return text
    .split('\n')
    .filter(Boolean)
    .slice(-n)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

// ---- Cookie ----

export function parseCookies(req) {
  const header = req.headers.cookie;
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    const raw = part.slice(idx + 1).trim();
    let value = raw;
    try {
      value = decodeURIComponent(raw);
    } catch {
      continue; // 畸形 % 序列：丢弃该条 cookie，不让单个坏值炸掉整个请求
    }
    out[part.slice(0, idx).trim()] = value;
  }
  return out;
}

export function sessionCookie(id, { secure = false } = {}) {
  return `${SESSION_COOKIE}=${id}; Path=/; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
}

export function clearSessionCookie({ secure = false } = {}) {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`;
}

/** CSRF cookie 是双提交的前端可读一半：不能加 HttpOnly。 */
export function csrfCookie(token) {
  return `${CSRF_COOKIE}=${token}; Path=/; SameSite=Lax`;
}

export function clearCsrfCookie() {
  return `${CSRF_COOKIE}=; Path=/; SameSite=Lax; Max-Age=0`;
}
