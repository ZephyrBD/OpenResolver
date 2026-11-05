import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpDataDir, startPanel, login, panelFetch } from './helpers/panel.mjs';

test('panel.csrf: 无 token 的写请求 403', async (t) => {
  const dataDir = tmpDataDir(t);
  const { base } = await startPanel(t, { dataDir });
  const { cookies } = await login(base);
  const res = await panelFetch(base, '/api/keys', {
    method: 'POST',
    cookies: { ugw_session: cookies.ugw_session }, // 只带会话，不带 csrf cookie/头
    body: { name: 'x' },
  });
  assert.equal(res.status, 403);
});

test('panel.csrf: token 错误 403', async (t) => {
  const dataDir = tmpDataDir(t);
  const { base } = await startPanel(t, { dataDir });
  const { cookies } = await login(base);
  const res = await panelFetch(base, '/api/keys', {
    method: 'POST',
    cookies: { ...cookies, ugw_csrf: 'a'.repeat(64) },
    headers: { 'x-ugw-csrf': 'b'.repeat(64) },
    body: { name: 'x' },
  });
  assert.equal(res.status, 403);
});

test('panel.csrf: 跨 Origin 必 403（即便 token 正确）', async (t) => {
  const dataDir = tmpDataDir(t);
  const { base } = await startPanel(t, { dataDir });
  const { cookies } = await login(base);
  const res = await panelFetch(base, '/api/keys', {
    method: 'POST',
    cookies,
    origin: 'https://evil.example',
    body: { name: 'x' },
  });
  assert.equal(res.status, 403);
});

test('panel.csrf: 同源 Origin + 正确 token 放行', async (t) => {
  const dataDir = tmpDataDir(t);
  const { base, port } = await startPanel(t, { dataDir });
  const { cookies } = await login(base);
  const res = await panelFetch(base, '/api/keys', {
    method: 'POST',
    cookies,
    origin: `http://127.0.0.1:${port}`,
    body: { name: 'ok' },
  });
  assert.equal(res.status, 200);
});

test('panel.csrf: 无 Origin（curl/工具）+ 正确 token 放行', async (t) => {
  const dataDir = tmpDataDir(t);
  const { base } = await startPanel(t, { dataDir });
  const { cookies } = await login(base);
  const res = await panelFetch(base, '/api/keys', { method: 'POST', cookies, body: { name: 'ok' } });
  assert.equal(res.status, 200);
});

test('panel.csrf: GET 不校验 CSRF', async (t) => {
  const dataDir = tmpDataDir(t);
  const { base } = await startPanel(t, { dataDir });
  const { cookies } = await login(base);
  // 只带会话 cookie，无 csrf cookie 也无头
  const res = await panelFetch(base, '/api/overview', { cookies: { ugw_session: cookies.ugw_session } });
  assert.equal(res.status, 200);
});

test('panel.csrf: 登录本身跨 Origin 403，无 Origin 放行', async (t) => {
  const dataDir = tmpDataDir(t);
  const { base } = await startPanel(t, { dataDir });
  const evil = await fetch(`${base}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
    body: JSON.stringify({ password: 'panel-pw' }),
  });
  assert.equal(evil.status, 403);

  const ok = await fetch(`${base}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'panel-pw' }),
  });
  assert.equal(ok.status, 200);
});

test('panel.csrf: 畸形 Cookie 值不炸 500，按无会话处理', async (t) => {
  const dataDir = tmpDataDir(t);
  const { base } = await startPanel(t, { dataDir });
  const res = await panelFetch(base, '/api/keys', {
    headers: { cookie: 'ugw_session=%zz; ugw_csrf=%qq' },
  });
  assert.equal(res.status, 401); // 畸形条目被跳过 → 无有效会话 → 401（而非 500）
});
