import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpDataDir, startPanel, login, panelFetch } from './helpers/panel.mjs';

const DAY = 24 * 3_600_000;

test('panel.auth: admin-passwd 工具设置 → 登录成功/失败 + scrypt 参数落盘', async (t) => {
  const dataDir = tmpDataDir(t);
  const tool = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'tools', 'admin-passwd.mjs');
  execFileSync(process.execPath, [tool, '--password', 's3cret-pw', '--data', dataDir], { encoding: 'utf8' });

  const admin = JSON.parse(fs.readFileSync(path.join(dataDir, 'admin.json'), 'utf8'));
  assert.equal(admin.iterations, 2 ** 15);
  assert.match(admin.salt, /^[0-9a-f]{32}$/);
  assert.match(admin.hash, /^[0-9a-f]{128}$/);

  const { base } = await startPanel(t, { dataDir, adminPassword: null });
  const ok = await login(base, 's3cret-pw');
  assert.equal(ok.res.status, 200);
  assert.ok(ok.cookies.ugw_session);
  assert.ok(ok.cookies.ugw_csrf);

  const bad = await login(base, 'wrong-pw');
  assert.equal(bad.res.status, 401);

  // cookie 属性
  const setCookie = ok.res.getSetCookie().join('\n');
  assert.match(setCookie, /ugw_session=[0-9a-f]{64}; Path=\/; HttpOnly; SameSite=Lax/);
  const csrfLine = ok.res.getSetCookie().find((c) => c.startsWith('ugw_csrf='));
  assert.match(csrfLine, /ugw_csrf=[0-9a-f]{64}; Path=\/; SameSite=Lax$/); // 不带 HttpOnly
});

test('panel.auth: UGW_SECURE_COOKIE=1 时 session cookie 加 Secure', async (t) => {
  const dataDir = tmpDataDir(t);
  const { base } = await startPanel(t, { dataDir, secureCookie: true });
  const ok = await login(base);
  assert.match(ok.res.getSetCookie().join('\n'), /ugw_session=[0-9a-f]{64}; Path=\/; HttpOnly; SameSite=Lax; Secure/);
});

test('panel.auth: 未设置 admin.json → /auth/login 503 提示先跑工具', async (t) => {
  const dataDir = tmpDataDir(t);
  const { base } = await startPanel(t, { dataDir, adminPassword: null });
  fs.rmSync(path.join(dataDir, 'admin.json'), { force: true });
  const { res } = await login(base, 'whatever');
  assert.equal(res.status, 503);
  const body = await res.json();
  assert.match(body.error.message, /admin-passwd/);
});

test('panel.auth: 限速——10 次失败锁 15 分钟，锁内正确密码也 429', async (t) => {
  const dataDir = tmpDataDir(t);
  let t0 = 1_700_000_000_000;
  const now = () => t0;
  const { base } = await startPanel(t, { dataDir, now });

  for (let i = 0; i < 10; i++) {
    const { res } = await login(base, 'nope');
    assert.equal(res.status, 401);
  }
  // 锁内：正确密码也 429
  const locked = await login(base, 'panel-pw');
  assert.equal(locked.res.status, 429);

  // security.json 持久化
  const security = JSON.parse(fs.readFileSync(path.join(dataDir, 'security.json'), 'utf8'));
  const ip = Object.keys(security.lockedUntil)[0];
  assert.equal(security.lockedUntil[ip], t0 + 15 * 60_000);

  // 锁过期后恢复
  t0 += 15 * 60_000 + 1;
  const ok = await login(base, 'panel-pw');
  assert.equal(ok.res.status, 200);

  // login-log.jsonl 追加
  const log = fs.readFileSync(path.join(dataDir, 'login-log.jsonl'), 'utf8').trim().split('\n');
  const entries = log.map((l) => JSON.parse(l));
  assert.ok(entries.some((e) => e.ok === false && e.reason === 'locked'));
  assert.ok(entries.some((e) => e.ok === true));
  for (const e of entries) {
    assert.equal(typeof e.ts, 'number');
    assert.ok(e.ip);
  }
});

test('panel.auth: 会话 TTL 7 天滑动续期', async (t) => {
  const dataDir = tmpDataDir(t);
  let t0 = 1_700_000_000_000;
  const now = () => t0;
  const { base } = await startPanel(t, { dataDir, now });
  const { cookies } = await login(base);

  // 6 天后仍有效，且滑动续期（lastSeen 被刷新）
  t0 += 6 * DAY;
  let res = await panelFetch(base, '/api/overview', { cookies });
  assert.equal(res.status, 200);

  // 再过 6.9 天（距上次访问 < 7 天）仍有效
  t0 += Math.floor(6.9 * DAY);
  res = await panelFetch(base, '/api/overview', { cookies });
  assert.equal(res.status, 200);

  // 再过 8 天（距最后访问 > 7 天）→ 401
  t0 += 8 * DAY;
  res = await panelFetch(base, '/api/overview', { cookies });
  assert.equal(res.status, 401);
});

test('panel.auth: 未过期但从未续期的会话在 7 天后失效', async (t) => {
  const dataDir = tmpDataDir(t);
  let t0 = 1_700_000_000_000;
  const now = () => t0;
  const { base } = await startPanel(t, { dataDir, now });
  const { cookies } = await login(base);
  t0 += 7 * DAY + 1;
  const res = await panelFetch(base, '/api/overview', { cookies });
  assert.equal(res.status, 401);
});

test('panel.auth: 登出吊销会话', async (t) => {
  const dataDir = tmpDataDir(t);
  const { base } = await startPanel(t, { dataDir });
  const { cookies } = await login(base);

  const res = await panelFetch(base, '/auth/logout', { method: 'POST', cookies });
  assert.equal(res.status, 200);
  assert.match(res.getSetCookie().join('\n'), /Max-Age=0/);

  const after = await panelFetch(base, '/api/overview', { cookies });
  assert.equal(after.status, 401);
});

test('panel.auth: 改密吊销其它会话 + 旧密码失效', async (t) => {
  const dataDir = tmpDataDir(t);
  const { base } = await startPanel(t, { dataDir });
  const a = await login(base);
  const b = await login(base);

  // 当前密码错误 → 401
  let res = await panelFetch(base, '/auth/password', {
    method: 'POST',
    cookies: a.cookies,
    body: { currentPassword: 'wrong', newPassword: 'new-pw-1' },
  });
  assert.equal(res.status, 401);

  res = await panelFetch(base, '/auth/password', {
    method: 'POST',
    cookies: a.cookies,
    body: { currentPassword: 'panel-pw', newPassword: 'new-pw-1' },
  });
  assert.equal(res.status, 200);

  // A 的当前会话保留
  assert.equal((await panelFetch(base, '/api/overview', { cookies: a.cookies })).status, 200);
  // B 的会话被吊销
  assert.equal((await panelFetch(base, '/api/overview', { cookies: b.cookies })).status, 401);
  // 旧密码登录失败，新密码成功
  assert.equal((await login(base, 'panel-pw')).res.status, 401);
  assert.equal((await login(base, 'new-pw-1')).res.status, 200);
});

test('panel.auth: 新密码少于 8 位 → 400 且不落盘', async (t) => {
  const dataDir = tmpDataDir(t);
  const { base } = await startPanel(t, { dataDir });
  const { cookies } = await login(base);

  const res = await panelFetch(base, '/auth/password', {
    method: 'POST',
    cookies,
    body: { currentPassword: 'panel-pw', newPassword: 'short-7' }, // 7 位
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.match(body.error.message, /至少 8 位/);

  // 未落盘：旧密码照常登录，短密码不生效
  assert.equal((await login(base, 'panel-pw')).res.status, 200);
  assert.equal((await login(base, 'short-7')).res.status, 401);
});

test('panel.auth: /auth/me 匿名与已登录两种形状', async (t) => {
  const dataDir = tmpDataDir(t);
  const { base } = await startPanel(t, { dataDir });
  const anon = await panelFetch(base, '/auth/me');
  assert.deepEqual(await anon.json(), { authenticated: false, csrfToken: null });

  const { cookies } = await login(base);
  const me = await panelFetch(base, '/auth/me', { cookies });
  const body = await me.json();
  assert.equal(body.authenticated, true);
  assert.equal(body.csrfToken, cookies.ugw_csrf);
});

test('panel.auth: 会话续期 60 秒限频——1 分钟内多次请求不重写 sessions.json', async (t) => {
  const dataDir = tmpDataDir(t);
  let t0 = 1_700_000_000_000;
  const now = () => t0;
  const { base } = await startPanel(t, { dataDir, now });
  const { cookies } = await login(base);
  const sessionsFile = path.join(dataDir, 'sessions.json');
  const mtimeAfterLogin = fs.statSync(sessionsFile).mtimeMs;

  // 30 秒内高频访问：lastSeen 不重写（mtime 不变）
  for (let i = 1; i <= 3; i++) {
    t0 += 10_000;
    const res = await panelFetch(base, '/api/overview', { cookies });
    assert.equal(res.status, 200);
  }
  assert.equal(fs.statSync(sessionsFile).mtimeMs, mtimeAfterLogin);

  // 超过 60 秒再访问：滑动续期落盘
  t0 += 61_000;
  const res = await panelFetch(base, '/api/overview', { cookies });
  assert.equal(res.status, 200);
  assert.ok(fs.statSync(sessionsFile).mtimeMs > mtimeAfterLogin);
});

test('panel.auth: 锁定期内重复登录只记一条 locked 日志（防刷 jsonl）', async (t) => {
  const dataDir = tmpDataDir(t);
  let t0 = 1_700_000_000_000;
  const now = () => t0;
  const { base } = await startPanel(t, { dataDir, now });

  for (let i = 0; i < 10; i++) await login(base, 'nope');
  const lockedCount = () =>
    fs
      .readFileSync(path.join(dataDir, 'login-log.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l))
      .filter((e) => e.reason === 'locked').length;

  // 锁内反复尝试
  for (let i = 0; i < 5; i++) {
    const { res } = await login(base, 'nope');
    assert.equal(res.status, 429);
  }
  assert.equal(lockedCount(), 1);

  // 锁解除后的尝试正常记录（locked → 解锁的转变落在正常路径）
  t0 += 15 * 60_000 + 1;
  const ok = await login(base, 'panel-pw');
  assert.equal(ok.res.status, 200);
  assert.equal(lockedCount(), 1);
  // 新一轮上锁后是另一把锁，重新可记
  for (let i = 0; i < 10; i++) await login(base, 'nope');
  const { res } = await login(base, 'nope');
  assert.equal(res.status, 429);
  assert.equal(lockedCount(), 2);
});
