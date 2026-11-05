import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpDataDir, startPanel, makePool, login, panelFetch } from './helpers/panel.mjs';

/** M6b 前端：静态产物可达性 + CSP 自洽 grep + API 形状冒烟（不执行浏览器 JS）。 */

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'panel', 'public');
const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:";

function readPublic(...parts) {
  return fs.readFileSync(path.join(PUBLIC_DIR, ...parts), 'utf8');
}

test('panel.frontend: 源码 grep——无 HTML 字符串注入、无外链资源（CSP 自洽）', () => {
  const files = ['index.html', 'app.js', 'style.css'];
  for (const file of files) {
    const src = readPublic(file);
    // 注入类 API（app.js 的说明注释已改写，不包含这些词）
    assert.ok(!/innerHTML|insertAdjacentHTML|outerHTML|document\.write/.test(src), `${file} 出现 HTML 注入 API`);
    // 外链资源：script/link src|href 指向协议地址、CSS url() 远程地址
    assert.ok(!/<script[^>]+src=["']https?:/i.test(src), `${file} 外链脚本`);
    assert.ok(!/<link[^>]+href=["']https?:/i.test(src), `${file} 外链样式/图标`);
    assert.ok(!/url\(\s*["']?https?:/i.test(src), `${file} CSS 远程资源`);
    assert.ok(!/@import/i.test(src), `${file} CSS @import`);
  }
  // index.html：script 标签必须是外链 module，不许内联
  const html = readPublic('index.html');
  for (const m of html.matchAll(/<script\b([^>]*)>/g)) {
    assert.match(m[1], /src=/, 'index.html 存在内联 script');
    assert.match(m[1], /type="module"/);
  }
  assert.ok(!/<style\b/i.test(html), 'index.html 存在内联 style 标签');
  assert.ok(!/\sstyle="/i.test(html), 'index.html 存在 style 属性');
  // 三个页面路由在 app.js 中注册
  const app = readPublic('app.js');
  for (const route of ['/dashboard', '/accounts', '/keys']) {
    assert.ok(app.includes(`'${route}'`), `app.js 缺路由 ${route}`);
  }
});

test('panel.frontend: / 200 + CSP；app.js / style.css 可达且 Content-Type 正确', async (t) => {
  const dataDir = tmpDataDir(t);
  const { base } = await startPanel(t, { dataDir }); // publicDir 缺省 → panel/public

  const home = await fetch(`${base}/`);
  assert.equal(home.status, 200);
  assert.equal(home.headers.get('content-type'), 'text/html; charset=utf-8');
  assert.equal(home.headers.get('content-security-policy'), CSP);
  const html = await home.text();
  assert.match(html, /\/panel\/app\.js/);
  assert.match(html, /\/panel\/style\.css/);

  const js = await fetch(`${base}/panel/app.js`);
  assert.equal(js.status, 200);
  assert.equal(js.headers.get('content-type'), 'text/javascript; charset=utf-8');
  const css = await fetch(`${base}/panel/style.css`);
  assert.equal(css.status, 200);
  assert.equal(css.headers.get('content-type'), 'text/css; charset=utf-8');
});

test('panel.frontend: 冒烟——三个页面用到的 API 全部存在且 200（防拼写漂移）', async (t) => {
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

  // 登录视图用到：/auth/me、/auth/logout
  const me = await panelFetch(base, '/auth/me', { cookies });
  assert.equal(me.status, 200);
  assert.equal((await me.json()).authenticated, true);
  const out = await panelFetch(base, '/auth/logout', { method: 'POST', cookies });
  assert.equal(out.status, 200);
});

test('panel.frontend: currentRoute 必须剥掉 hash 的 # 前缀再查 routes（M6 真机回归：否则所有路由回退仪表盘）', async () => {
  const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'panel', 'public');
  const src = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
  const fn = src.slice(src.indexOf('function currentRoute'), src.indexOf('function setActiveNav'));
  assert.match(fn, /slice\(1\)/, 'currentRoute 里必须对 location.hash 做 slice(1) 归一化');
  const routesSrc = src.slice(src.indexOf('const routes'), src.indexOf('function currentRoute'));
  assert.ok(routesSrc.includes("'\/accounts'"), 'routes 键是不带 # 的路径');
});
