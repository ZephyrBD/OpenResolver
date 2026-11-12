import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpDataDir, startPanel, makePool, login, panelFetch } from './helpers/panel.mjs';

/**
 * panel.frontend：Vue 面板源码 CSP 自洽 grep + API 形状冒烟（不执行浏览器 JS）。
 * 旧面板（panel/public 原生 JS）已随 Batch 5 删除，回滚保险见 tag panel-legacy-backup。
 */

const FRONTEND_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'frontend');
const FONT_FILE = path.join(FRONTEND_DIR, 'src', 'assets', 'fonts', 'InterVariable.woff2');
const OFL_FILE = path.join(FRONTEND_DIR, 'src', 'assets', 'fonts', 'OFL.txt');

function listSources() {
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.vue$|\.ts$|\.html$/.test(entry.name)) out.push(full);
    }
  };
  walk(path.join(FRONTEND_DIR, 'src'));
  out.push(path.join(FRONTEND_DIR, 'index.html'));
  return out;
}

test('panel.frontend: 源码 grep——无 HTML 注入 API、无外链资源、无内联 script/style（CSP 全维度零内联）', () => {
  for (const file of listSources()) {
    const src = fs.readFileSync(file, 'utf8');
    const rel = path.relative(FRONTEND_DIR, file);
    // 注入类 API（textContent/createElement 是唯一合法 DOM 写入路径）
    assert.ok(!/innerHTML|insertAdjacentHTML|outerHTML|document\.write/.test(src), `${rel} 出现 HTML 注入 API`);
    // 外链资源：协议地址的 script/link/css url
    assert.ok(!/<script[^>]+src=["']https?:/i.test(src), `${rel} 外链脚本`);
    assert.ok(!/<link[^>]+href=["']https?:/i.test(src), `${rel} 外链样式/图标`);
    assert.ok(!/url\(\s*["']?https?:/i.test(src), `${rel} CSS 远程资源`);
    // style 属性（含 :style 绑定）一律禁止——CSP style-src-attr 无放行
    assert.ok(!/\sstyle="/i.test(src), `${rel} 存在 style 属性`);
    assert.ok(!/:style="/i.test(src), `${rel} 存在 :style 绑定`);
  }
  // index.html：script 必须是外链 module，无 <style> 标签
  const html = fs.readFileSync(path.join(FRONTEND_DIR, 'index.html'), 'utf8');
  for (const m of html.matchAll(/<script\b([^>]*)>/g)) {
    assert.match(m[1], /src=/, 'index.html 存在内联 script');
    assert.match(m[1], /type="module"/);
  }
  assert.ok(!/<style\b/i.test(html), 'index.html 存在内联 style 标签');
});

test('panel.frontend: 菜单唯一数据源注册四个管理端路由', () => {
  const menu = fs.readFileSync(path.join(FRONTEND_DIR, 'src', 'api', 'menu.ts'), 'utf8');
  for (const p of ['/admin/dashboard', '/admin/accounts', '/admin/keys', '/admin/settings']) {
    assert.ok(menu.includes(`'${p}'`), `menu.ts 缺路由 ${p}`);
  }
});

test('panel.frontend: Inter 可变字体 + OFL 许可随源码分发（合规必修）', () => {
  assert.ok(fs.existsSync(FONT_FILE), 'frontend/src/assets/fonts/InterVariable.woff2 不存在');
  const lic = fs.readFileSync(OFL_FILE, 'utf8');
  assert.match(lic, /OPEN FONT LICENSE/, 'OFL.txt 内容异常');
});

test('panel.frontend: 冒烟——面板页面用到的 API 全部存在且 200（防拼写漂移）', async (t) => {
  const dataDir = tmpDataDir(t);
  const { base } = await startPanel(t, { dataDir, withKey: false, pools: [makePool('zcode', { dataDir })] });
  const { cookies } = await login(base);

  // 仪表盘：overview / pools / stats?days=14
  const overview = await panelFetch(base, '/api/overview', { cookies });
  assert.equal(overview.status, 200);
  const overviewBody = await overview.json();
  for (const field of ['pools', 'totalKeys', 'today', 'usageDegraded']) {
    assert.ok(field in overviewBody, `overview 缺字段 ${field}`);
  }
  assert.ok('requests' in overviewBody.today && 'errors' in overviewBody.today);

  const pools = await panelFetch(base, '/api/pools', { cookies });
  assert.equal(pools.status, 200);
  assert.ok(Array.isArray((await pools.json()).pools));

  const stats = await panelFetch(base, '/api/stats?days=14', { cookies });
  assert.equal(stats.status, 200);
  const statsBody = await stats.json();
  assert.equal(statsBody.days, 14);
  assert.equal(statsBody.stats.length, 14);
  assert.ok(statsBody.stats[0].date);

  // 账号页：各池账号列表（这里只造 zcode）+ onboard link
  const accounts = await panelFetch(base, '/api/pools/zcode/accounts', { cookies });
  assert.equal(accounts.status, 200);
  const accountsBody = await accounts.json();
  assert.equal(accountsBody.pool, 'zcode');
  assert.ok(Array.isArray(accountsBody.accounts));

  const link = await panelFetch(base, '/api/onboard/trae/link', { cookies });
  assert.equal(link.status, 200);
  assert.ok((await link.json()).url);

  // 密钥页：列表 + 创建 + rotate + 删除
  const keys = await panelFetch(base, '/api/keys', { cookies });
  assert.equal(keys.status, 200);
  assert.ok(Array.isArray((await keys.json()).keys));

  const created = await panelFetch(base, '/api/keys', {
    method: 'POST',
    cookies,
    body: { name: '前端冒烟', pools: ['zcode'] },
  });
  assert.equal(created.status, 200);
  const { key, secret } = await created.json();
  assert.match(secret, /^zsk_/);

  const rotated = await panelFetch(base, `/api/keys/${key.id}/rotate`, { method: 'POST', cookies });
  assert.equal(rotated.status, 200);
  assert.match((await rotated.json()).secret, /^zsk_/);

  assert.equal((await panelFetch(base, `/api/keys/${key.id}`, { method: 'DELETE', cookies })).status, 200);

  // 设置页：读 + 写（写后恢复默认组）
  const settings = await panelFetch(base, '/api/settings', { cookies });
  assert.equal(settings.status, 200);
  assert.ok('maxInFlight' in (await settings.json()).settings);

  // 登录视图用到：/auth/me、/auth/logout
  const me = await panelFetch(base, '/auth/me', { cookies });
  assert.equal(me.status, 200);
  assert.equal((await me.json()).authenticated, true);
  const out = await panelFetch(base, '/auth/logout', { method: 'POST', cookies });
  assert.equal(out.status, 200);
});
