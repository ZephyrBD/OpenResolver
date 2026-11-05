import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import { createGateway } from '../../gateway.mjs';
import { createPanelGateway } from '../../panel/api.mjs';
import { createUsageRecorder } from '../../panel/usage.mjs';
import { createPoolScheduler } from '../../pools/base.mjs';
import { saveAdmin } from '../../panel/admin.mjs';
import { createKey } from '../../auth/keys.mjs';

/** 面板测试组手：真 HTTP、真临时目录（os.tmpdir()）、可注入时钟。 */

export function tmpDataDir(t, prefix = 'ugw-panel-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** 带调度器的池桩（面板账号增删改需要 runtime 数组与 settings）。 */
export function makePool(name, { accounts = [], dataDir, models = [] } = {}) {
  const scheduler = createPoolScheduler({
    name,
    accounts,
    settingsFile: path.join(dataDir, 'pool-settings.json'),
  });
  return {
    name,
    type: 'pool',
    accounts: scheduler.accounts,
    // 真实池（pools/zcode|qoder|trae 的 createXxxPool）把调度器整个挂在 .scheduler 上，
    // 不在池对象上直接铺 snapshot/settings——helper 必须与真实形状一致，否则面板的
    // sched() 适配层测不到（M6 真机排查教训）。
    scheduler,
    models: () => models,
  };
}

export async function startPanel(
  t,
  {
    pools = [],
    dataDir,
    adminPassword = 'panel-pw',
    config = {},
    now,
    secureCookie = false,
    publicDir,
    usage,
    withKey = true,
    panelOptions,
  } = {},
) {
  const clock = now ?? (() => Date.now());
  const recorder = usage ?? createUsageRecorder({ dataDir, maxFileBytes: config.maxUsageFileBytes, now: clock });
  const db = { version: 1, keys: [] };
  let full = null;
  if (withKey) full = createKey(db, { name: 't' }).full;
  if (adminPassword) saveAdmin(path.join(dataDir, 'admin.json'), { password: adminPassword });

  const panel = createPanelGateway({
    config: { version: '0.1.0', ...config },
    pools,
    db,
    keysFile: path.join(dataDir, 'keys.json'),
    dataDir,
    now: clock,
    secureCookie,
    publicDir,
    usage: recorder,
    ...(panelOptions || {}),
  });
  const server = createGateway({ config: { version: '0.1.0', ...config }, pools, db, panel, usage: recorder });
  const port = await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
  t.after(() => new Promise((r) => server.close(r)));
  return {
    base: `http://127.0.0.1:${port}`,
    port,
    db,
    secret: full,
    dataDir,
    usage: recorder,
  };
}

/** node:http 原生请求（不用 fetch：undici 拒绝打少数被拉黑的临时端口）。 */
function rawRequest({ port, pathname, method = 'GET', headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: pathname, method, headers },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({
            status: res.statusCode,
            headers: { get: (n) => res.headers[n.toLowerCase()] },
            getSetCookie: () => res.headers['set-cookie'] || [],
            text: () => text,
            json: () => JSON.parse(text),
          });
        });
      },
    );
    req.on('error', reject);
    if (body !== undefined) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

/** 登录并返回 { res, cookies }（cookie 值已提取）。 */
export async function login(base, password = 'panel-pw', { origin } = {}) {
  const port = Number(new URL(base).port);
  const res = await rawRequest({
    port,
    pathname: '/auth/login',
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) },
    body: JSON.stringify({ password }),
  });
  const cookies = {};
  for (const line of res.getSetCookie()) {
    const [pair] = line.split(';');
    const idx = pair.indexOf('=');
    cookies[pair.slice(0, idx)] = pair.slice(idx + 1);
  }
  return { res, cookies };
}

/** 带 session + CSRF 头的请求便捷封装。 */
export function panelFetch(base, pathname, { method = 'GET', cookies = {}, body, origin, headers = {} } = {}) {
  const port = Number(new URL(base).port);
  const cookieHeader = Object.entries(cookies)
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
  return rawRequest({
    port,
    pathname,
    method,
    headers: {
      ...(cookieHeader ? { cookie: cookieHeader } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(cookies.ugw_csrf ? { 'x-ugw-csrf': cookies.ugw_csrf } : {}),
      ...(origin ? { origin } : {}),
      ...(headers || {}),
    },
    ...(body !== undefined ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
  });
}
