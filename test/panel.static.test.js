import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { seedDb } from './helpers/gateway.mjs';
import { createGateway } from '../gateway.mjs';
import { tmpDataDir, startPanel, login, panelFetch } from './helpers/panel.mjs';

const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:";

function makePublicDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ugw-public-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><html><body>面板</body></html>');
  fs.writeFileSync(path.join(dir, 'app.js'), 'console.log(1)');
  return dir;
}

test('panel.static: public 存在 → / 与 /panel 200 + CSP + no-store', async (t) => {
  const dataDir = tmpDataDir(t);
  const publicDir = makePublicDir(t);
  const { base } = await startPanel(t, { dataDir, publicDir });

  for (const pathname of ['/', '/panel']) {
    const res = await fetch(`${base}${pathname}`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'text/html; charset=utf-8');
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.match(await res.text(), /面板/);
  }
  const js = await fetch(`${base}/panel/app.js`);
  assert.equal(js.status, 200);
  assert.equal(js.headers.get('content-type'), 'text/javascript; charset=utf-8');

  // 静态响应也带安全头
  assert.equal((await fetch(`${base}/`)).headers.get('content-security-policy'), CSP);
});

test('panel.static: 静态资源缺失 404', async (t) => {
  const dataDir = tmpDataDir(t);
  const publicDir = makePublicDir(t);
  const { base } = await startPanel(t, { dataDir, publicDir });
  assert.equal((await fetch(`${base}/panel/nope.js`)).status, 404);
});

test('panel.static: public 不存在 → / 与 /panel 503 面板文件未部署', async (t) => {
  const dataDir = tmpDataDir(t);
  const { base } = await startPanel(t, { dataDir, publicDir: path.join(dataDir, 'no-such-dir') });
  for (const pathname of ['/', '/panel']) {
    const res = await fetch(`${base}${pathname}`);
    assert.equal(res.status, 503);
    assert.match((await res.json()).error.message, /面板文件未部署/);
  }
  // /panel 下的其它资源也是 404 而不是穿越
  assert.equal((await fetch(`${base}/panel/anything.js`)).status, 404);
});

test('panel.static: 路径穿越 4xx', async (t) => {
  const dataDir = tmpDataDir(t);
  const publicDir = makePublicDir(t);
  const { base } = await startPanel(t, { dataDir, publicDir });

  // keys.json 放在 dataDir 下，确认穿越拿不到
  fs.writeFileSync(path.join(dataDir, 'keys.json'), '{"secret":1}');

  // URL 类会归一化 ..，落到 /data/keys.json → 面板 404
  assert.equal((await fetch(`${base}/panel/../data/keys.json`)).status, 404);
  // 编码后的 .. 不被归一化，必须被前缀校验拦住
  const encoded = await fetch(`${base}/panel/%2e%2e%2fkeys.json`);
  assert.ok(encoded.status >= 400 && encoded.status < 500);
  const body = await encoded.text();
  assert.ok(!body.includes('secret'), '穿越泄漏');
});

test('panel.static: 安全头在面板 API 响应上存在、推理面上不存在', async (t) => {
  const dataDir = tmpDataDir(t);
  const { base, secret } = await startPanel(t, { dataDir });

  const api = await fetch(`${base}/auth/me`);
  assert.equal(api.headers.get('content-security-policy'), CSP);
  assert.equal(api.headers.get('x-frame-options'), 'DENY');
  assert.equal(api.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(api.headers.get('referrer-policy'), 'no-referrer');

  // 推理面（/v1/*）不加面板安全头：/health 也一样
  const health = await fetch(`${base}/health`);
  assert.equal(health.status, 200);
  assert.equal(health.headers.get('content-security-policy'), null);
  assert.equal(health.headers.get('x-frame-options'), null);
  assert.equal(health.headers.get('referrer-policy'), null);
  assert.ok(secret || true); // seedDb 副作用占位避免 lint
});

test('panel.static: 面板 API 错误响应也带安全头', async (t) => {
  const dataDir = tmpDataDir(t);
  const { base } = await startPanel(t, { dataDir });
  const res = await fetch(`${base}/api/overview`); // 401
  assert.equal(res.status, 401);
  assert.equal(res.headers.get('x-frame-options'), 'DENY');
});

test('panel.static: gateway 无 panel 时 /health 行为不变（回归）', async (t) => {
  const dataDir = tmpDataDir(t);
  const { db } = seedDb({ name: 'r' });
  const server = createGateway({ config: { version: '0.1.0' }, pools: [], db });
  const port = await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
  t.after(() => new Promise((r) => server.close(r)));
  const res = await fetch(`http://127.0.0.1:${port}/health`);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).ok, true);
  // 无面板时 /api/* 走原来的 404
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/overview`)).status, 404);
});

test('panel.static: /panel/ 下畸形 % 编码 → 400 而非 500', async (t) => {
  const dataDir = tmpDataDir(t);
  const publicDir = makePublicDir(t);
  const { base } = await startPanel(t, { dataDir, publicDir });
  const res = await fetch(`${base}/panel/%zz.js`);
  assert.equal(res.status, 400);
});
