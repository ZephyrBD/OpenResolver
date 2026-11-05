import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startStub } from './helpers/stub.mjs';
import { tmpDataDir, startPanel, makePool, login, panelFetch } from './helpers/panel.mjs';
import { loadAccounts } from '../pools/zcode/accounts.mjs';

const PAT = 'pt-abcdef1234567890';
const JWT = 'eyJhbGciOi.eyJzdWIi.jwT-签名部分很长很长';

function seedAccounts(dir, name, accounts) {
  fs.mkdirSync(path.join(dir, 'pools', name), { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    path.join(dir, 'pools', name, 'accounts.json'),
    JSON.stringify(accounts, null, 2),
    { mode: 0o600 },
  );
}

test('panel.api: 未登录访问 API 401', async (t) => {
  const dataDir = tmpDataDir(t);
  const { base } = await startPanel(t, { dataDir });
  assert.equal((await fetch(`${base}/api/overview`)).status, 401);
});

test('panel.api: overview 聚合形状', async (t) => {
  const dataDir = tmpDataDir(t);
  const pool = makePool('zcode', {
    dataDir,
    accounts: [
      { id: 'a1', label: 'ok 号', jwt: JWT },
      { id: 'a2', label: '冷却号' },
    ],
  });
  pool.scheduler.updateAccount('a2', { cooldownUntil: Date.now() + 60_000, cooldownKind: 'rate_limit' });
  const { base } = await startPanel(t, { dataDir, pools: [pool] });
  const { cookies } = await login(base);
  const body = await (await panelFetch(base, '/api/overview', { cookies })).json();

  assert.equal(body.pools.length, 1);
  const stat = body.pools[0];
  assert.deepEqual(
    { name: stat.name, type: stat.type, accounts: stat.accounts, ok: stat.ok, cooling: stat.cooling, needsLogin: stat.needsLogin },
    { name: 'zcode', type: 'pool', accounts: 2, ok: 2, cooling: 1, needsLogin: 0 },
  );
  assert.equal(body.totalKeys, 1);
  assert.deepEqual(Object.keys(body.today).sort(), ['errors', 'inputTokens', 'outputTokens', 'requests']);
  assert.equal(body.usageDegraded, false);
});

test('panel.api: pools 列表带 snapshot 与 settings；PATCH settings 白名单', async (t) => {
  const dataDir = tmpDataDir(t);
  const pool = makePool('zcode', { dataDir, accounts: [{ id: 'a1', label: 'x' }] });
  const { base } = await startPanel(t, { dataDir, pools: [pool] });
  const { cookies } = await login(base);

  const body = await (await panelFetch(base, '/api/pools', { cookies })).json();
  assert.equal(body.pools[0].name, 'zcode');
  assert.ok(body.pools[0].accounts[0].id === 'a1');
  assert.ok('maxInFlight' in body.pools[0].settings);

  const patched = await panelFetch(base, '/api/pools/zcode/settings', {
    method: 'PATCH',
    cookies,
    body: { topN: 2, evilField: 1 },
  });
  assert.equal(patched.status, 400);

  const ok = await panelFetch(base, '/api/pools/zcode/settings', { method: 'PATCH', cookies, body: { topN: 2 } });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).settings.topN, 2);
  assert.equal(pool.scheduler.settings.topN, 2);
});

test('panel.api: accounts 列表脱敏——响应里 grep 不到完整 pat/jwt', async (t) => {
  const dataDir = tmpDataDir(t);
  seedAccounts(dataDir, 'zcode', [{ id: 'a1', label: '主号', jwt: JWT, pat: PAT, refreshToken: 'rt-99887766' }]);
  const pool = makePool('zcode', { dataDir, accounts: loadAccounts(path.join(dataDir, 'pools', 'zcode')) });
  const { base } = await startPanel(t, { dataDir, pools: [pool] });
  const { cookies } = await login(base);

  const res = await panelFetch(base, '/api/pools/zcode/accounts', { cookies });
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.ok(!text.includes(JWT), '完整 jwt 泄漏');
  assert.ok(!text.includes(PAT), '完整 pat 泄漏');
  assert.ok(!text.includes('rt-99887766'), '完整 refreshToken 泄漏');
  assert.ok(text.includes(`***${JWT.slice(-4)}`));
  assert.ok(text.includes(`***${PAT.slice(-4)}`));
});

test('panel.api: 新增/编辑/清冷却/删除账号全链路（含磁盘断言）', async (t) => {
  const dataDir = tmpDataDir(t);
  const pool = makePool('zcode', { dataDir });
  const { base } = await startPanel(t, { dataDir, pools: [pool] });
  const { cookies } = await login(base);
  const disk = () => loadAccounts(path.join(dataDir, 'pools', 'zcode'));

  // 新增
  const add = await panelFetch(base, '/api/pools/zcode/accounts', {
    method: 'POST',
    cookies,
    body: { label: '新号', jwt: JWT, pat: PAT },
  });
  assert.equal(add.status, 200);
  const added = (await add.json()).account;
  assert.ok(added.id.startsWith('zcode-'));
  assert.equal(pool.accounts.length, 1);
  assert.equal(disk().length, 1);
  assert.equal(disk()[0].jwt, JWT); // 磁盘是明文

  // 编辑（白名单）
  const patched = await panelFetch(base, `/api/pools/zcode/accounts/${added.id}`, {
    method: 'PATCH',
    cookies,
    body: { label: '改名', manualWeight: 5, jwt: 'hack' },
  });
  assert.equal(patched.status, 400); // jwt 不在白名单
  const okPatch = await panelFetch(base, `/api/pools/zcode/accounts/${added.id}`, {
    method: 'PATCH',
    cookies,
    body: { label: '改名', manualWeight: 5, enabled: false },
  });
  assert.equal(okPatch.status, 200);
  const after = (await okPatch.json()).account;
  assert.equal(after.label, '改名');
  assert.equal(after.manualWeight, 5);
  assert.equal(after.enabled, false);
  assert.equal(disk()[0].label, '改名');

  // 清冷却
  pool.scheduler.updateAccount(added.id, { cooldownUntil: Date.now() + 3_600_000, cooldownKind: 'rate_limit', consecutiveFails: 2 });
  const reset = await panelFetch(base, `/api/pools/zcode/accounts/${added.id}/reset`, { method: 'POST', cookies });
  assert.equal(reset.status, 200);
  const resetBody = (await reset.json()).account;
  assert.equal(resetBody.cooldownRemainingMs, 0);
  assert.equal(resetBody.state, 'ok');
  const runtime = pool.accounts.find((a) => a.id === added.id);
  assert.equal(runtime.consecutiveFails, 0);
  assert.equal(runtime.cooldownKind, null);

  // 删除
  const del = await panelFetch(base, `/api/pools/zcode/accounts/${added.id}`, { method: 'DELETE', cookies });
  assert.equal(del.status, 200);
  assert.equal(pool.accounts.length, 0);
  assert.equal(disk().length, 0);

  // 删除不存在的
  assert.equal(
    (await panelFetch(base, '/api/pools/zcode/accounts/nope', { method: 'DELETE', cookies })).status,
    404,
  );
});

test('panel.api: 未知池 404、路径穿越 4xx', async (t) => {
  const dataDir = tmpDataDir(t);
  const { base } = await startPanel(t, { dataDir, pools: [makePool('zcode', { dataDir })] });
  const { cookies } = await login(base);
  assert.equal((await panelFetch(base, '/api/pools/nope/accounts', { cookies })).status, 404);
  assert.equal((await panelFetch(base, '/api/pools/%2E%2E/settings', { method: 'PATCH', cookies, body: {} })).status, 404);
  assert.equal((await panelFetch(base, '/api/pools/zcode%2F../accounts', { cookies })).status, 404);
});

test('panel.api: keys 创建一次性明文 + rotate + delete', async (t) => {
  const dataDir = tmpDataDir(t);
  const { base, db } = await startPanel(t, { dataDir });
  const { cookies } = await login(base);

  // 创建：明文只出现一次
  const created = await panelFetch(base, '/api/keys', { method: 'POST', cookies, body: { name: '面板发的' } });
  assert.equal(created.status, 200);
  const { key, secret } = await created.json();
  assert.match(secret, /^zsk_/);
  assert.equal(key.name, '面板发的');
  assert.equal(db.keys.length, 2);
  const listText = await (await panelFetch(base, '/api/keys', { cookies })).text();
  assert.ok(!listText.includes(secret), '列表泄漏明文');
  assert.ok(!listText.includes('keyHash'), '列表回显哈希');

  // rotate：新明文返回一次，旧密钥失效
  const rotated = await panelFetch(base, `/api/keys/${key.id}/rotate`, { method: 'POST', cookies });
  assert.equal(rotated.status, 200);
  const { secret: newSecret, key: newKey } = await rotated.json();
  assert.match(newSecret, /^zsk_/);
  assert.notEqual(newSecret, secret);
  assert.equal(newKey.id, key.id); // 原位替换
  assert.equal(db.keys.length, 2);

  // delete
  const del = await panelFetch(base, `/api/keys/${key.id}`, { method: 'DELETE', cookies });
  assert.equal(del.status, 200);
  assert.equal(db.keys.length, 1);
  assert.equal((await panelFetch(base, `/api/keys/${key.id}`, { method: 'DELETE', cookies })).status, 404);

  // keys.json 落盘
  const persisted = JSON.parse(fs.readFileSync(path.join(dataDir, 'keys.json'), 'utf8'));
  assert.equal(persisted.keys.length, 1);
});

test('panel.api: trae onboard link → callback 端到端（桩上游）', async (t) => {
  const dataDir = tmpDataDir(t);
  const traePool = makePool('trae', { dataDir });
  const { base } = await startPanel(t, { dataDir, pools: [traePool] });
  const { cookies } = await login(base);

  const link = await (await panelFetch(base, '/api/onboard/trae/link', { cookies })).json();
  assert.match(link.url, /^https:\/\/www\.trae\.cn\/authorization\?/);
  assert.match(link.machineId, /^[0-9a-f]{32}$/);
  assert.match(link.deviceId, /^[0-9a-f]{32}$/);
  assert.ok(link.flowId);
  const flows = JSON.parse(fs.readFileSync(path.join(dataDir, 'onboard-flows.json'), 'utf8'));
  assert.ok(flows.flows[link.flowId]);

  const stub = await startStub(t, (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    if (req.url.includes('ExchangeToken')) {
      res.end(JSON.stringify({ Result: { Token: 'jwt-panel', RefreshToken: 'rt-panel', TokenExpireAt: 1_700_000_000_000 + 86_400_000 } }));
    } else {
      res.end(JSON.stringify({ Result: { UserID: '99001122', ScreenName: '面板用户' } }));
    }
  });

  const savedEnv = process.env.UGW_TRAE_API_HOST;
  process.env.UGW_TRAE_API_HOST = stub.origin;
  t.after(() => {
    if (savedEnv === undefined) delete process.env.UGW_TRAE_API_HOST;
    else process.env.UGW_TRAE_API_HOST = savedEnv;
  });

  const userInfo = encodeURIComponent(JSON.stringify({ UserID: '99001122', ScreenName: '面板用户' }));
  const callbackUrl = `http://127.0.0.1:18080/authorize?refreshToken=rt-raw&userInfo=${userInfo}`;

  const done = await panelFetch(base, '/api/onboard/trae/callback', {
    method: 'POST',
    cookies,
    body: { flowId: link.flowId, callbackUrl },
  });
  assert.equal(done.status, 200);
  const { account } = await done.json();
  assert.equal(account.id, 'trae-99001122');
  assert.equal(account.nickname, '面板用户');
  assert.ok(account.jwt.startsWith('***'));
  assert.ok(!JSON.stringify(account).includes('jwt-panel'));
  assert.ok(!JSON.stringify(account).includes('rt-panel'));

  // 磁盘与运行态
  const disk = loadAccounts(path.join(dataDir, 'pools', 'trae'));
  assert.equal(disk.length, 1);
  assert.equal(disk[0].jwt, 'jwt-panel');
  assert.equal(disk[0].machineId, link.machineId); // 9074：用 flow 里那对
  assert.equal(traePool.accounts.length, 1);

  // flow 一次性
  const replay = await panelFetch(base, '/api/onboard/trae/callback', {
    method: 'POST',
    cookies,
    body: { flowId: link.flowId, callbackUrl },
  });
  assert.equal(replay.status, 404);

  // 未知 flowId 404
  const missing = await panelFetch(base, '/api/onboard/trae/callback', {
    method: 'POST',
    cookies,
    body: { flowId: 'no-such-flow', callbackUrl },
  });
  assert.equal(missing.status, 404);
});

test('panel.api: qoder PAT 打桩全链路 + 非法 region 400', async (t) => {
  const dataDir = tmpDataDir(t);
  const qoderCn = makePool('qoder-cn', { dataDir });

  const exchange = await startStub(t, (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ token: 'job-1', refresh_token: 'jrt-1', expires_in: 3600 }));
  });
  const userinfo = await startStub(t, (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'uid-777', email: 'a@b.c', name: '七七' }));
  });

  const { base } = await startPanel(t, {
    dataDir,
    pools: [qoderCn],
    panelOptions: {
      qoderExchangeUrl: `${exchange.origin}/exchange`,
      qoderUserinfoUrl: `${userinfo.origin}/userinfo`,
    },
  });
  const { cookies } = await login(base);

  const bad = await panelFetch(base, '/api/onboard/qoder', { method: 'POST', cookies, body: { pat: PAT, region: 'mars' } });
  assert.equal(bad.status, 400);

  const ok = await panelFetch(base, '/api/onboard/qoder', { method: 'POST', cookies, body: { pat: PAT, region: 'cn' } });
  assert.equal(ok.status, 200);
  const { account } = await ok.json();
  assert.equal(account.userID, 'uid-777');
  assert.ok(account.pat.startsWith('***'));
  assert.ok(!JSON.stringify(account).includes(PAT));

  const disk = loadAccounts(path.join(dataDir, 'pools', 'qoder-cn'));
  assert.equal(disk.length, 1);
  assert.equal(disk[0].pat, PAT);
  assert.equal(qoderCn.accounts.length, 1);
});

test('panel.api: stats 与 logs 路由', async (t) => {
  const dataDir = tmpDataDir(t);
  const { base } = await startPanel(t, { dataDir });
  const { cookies } = await login(base);
  const stats = await (await panelFetch(base, '/api/stats?days=3', { cookies })).json();
  assert.equal(stats.days, 3);
  assert.equal(stats.stats.length, 3);
  assert.ok(stats.stats[0].date);

  const logLines = await (await panelFetch(base, '/api/logs', { cookies })).json();
  assert.ok(Array.isArray(logLines.logs));
  assert.ok(logLines.logs.length >= 1); // 本测试的登录已记录
});

test('panel.api: POST 账号带已存在 id → 409 不覆盖', async (t) => {
  const dataDir = tmpDataDir(t);
  const pool = makePool('zcode', { dataDir });
  const { base } = await startPanel(t, { dataDir, pools: [pool] });
  const { cookies } = await login(base);

  const first = await panelFetch(base, '/api/pools/zcode/accounts', {
    method: 'POST',
    cookies,
    body: { id: 'zcode-dup000', label: '第一个', jwt: JWT },
  });
  assert.equal(first.status, 200);

  const dup = await panelFetch(base, '/api/pools/zcode/accounts', {
    method: 'POST',
    cookies,
    body: { id: 'zcode-dup000', label: '冒名的', jwt: 'eyJhbGciOi.其他.x' },
  });
  assert.equal(dup.status, 409);
  const disk = loadAccounts(path.join(dataDir, 'pools', 'zcode'));
  assert.equal(disk.length, 1);
  assert.equal(disk[0].label, '第一个');
});

test('panel.api: 路径里畸形 % 编码 → 400 而非 500', async (t) => {
  const dataDir = tmpDataDir(t);
  const { base } = await startPanel(t, { dataDir });
  const { cookies } = await login(base);
  const res = await panelFetch(base, '/api/pools/%zz/accounts', { cookies });
  assert.equal(res.status, 400);
});

test('panel.api: /api/pools 返回真实调度器快照与 settings（M6 真机回归：池对象把调度器包在 .scheduler 里）', async (t) => {
  const dataDir = tmpDataDir(t);
  const pool = makePool('zcode', { dataDir, accounts: [{ id: 'a1', label: 'x' }, { id: 'a2', label: 'y' }] });
  const { base } = await startPanel(t, { dataDir, pools: [pool] });
  const { cookies } = await login(base);
  const res = await panelFetch(base, '/api/pools', { cookies });
  assert.equal(res.status, 200);
  const { pools } = await res.json();
  const z = pools.find((p) => p.name === 'zcode');
  assert.equal(z.accounts.length, 2, '快照必须来自 scheduler.snapshot()，不能恒为空数组');
  assert.ok('state' in z.accounts[0], '快照行应有调度器状态字段');
  assert.ok(z.settings && 'maxInFlight' in z.settings, 'settings 必须存在（undefined 会被 JSON 丢弃）');
});

test('panel.api: trae 回调缺 flowId → 400 明确提示（M6 真机回归：前端曾漏传导致永远 404）', async (t) => {
  const dataDir = tmpDataDir(t);
  const { base } = await startPanel(t, { dataDir });
  const { cookies } = await login(base);
  const res = await panelFetch(base, '/api/onboard/trae/callback', {
    method: 'POST',
    cookies,
    body: { callbackUrl: 'http://127.0.0.1:18080/authorize?refreshToken=x' },
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.match(body.error.message, /flowId/);
});

test('panel.frontend: trae 回调提交必须携带 flowId（M6 真机回归）', async () => {
  const publicDir = path.join(import.meta.dirname, '..', 'panel', 'public');
  const src = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
  const at = src.indexOf("api('/api/onboard/trae/callback'");
  const handler = src.slice(at, at + 300);
  assert.match(handler, /flowId/, '回调 POST body 里必须带 flowId');
});

test('panel.api: /api/models 面板侧模型清单（session 鉴权、全池、/v1/models 同形状）', async (t) => {
  const dataDir = tmpDataDir(t);
  const pool = makePool('zcode', {
    dataDir,
    accounts: [{ id: 'a1' }],
    models: [{ id: 'GLM-5.3', display_name: 'GLM-5.3 (ZCode)', context_window: 128000, supports_tools: true, supports_thinking: true }],
  });
  const { base } = await startPanel(t, { dataDir, pools: [pool] });
  const { cookies } = await login(base);
  const res = await panelFetch(base, '/api/models', { cookies });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.object, 'list');
  assert.deepEqual(body.data, [{
    id: 'zcode/GLM-5.3',
    display_name: 'GLM-5.3 (ZCode)',
    pool: 'zcode',
    upstream_model: 'GLM-5.3',
    available: true,
    pool_accounts: 1,
    context_window: 128000,
    max_tokens: null,
    supports_tools: true,
    supports_thinking: true,
    verified: true,
    degraded: false,
  }]);
  // 未登录拒绝
  const anon = await panelFetch(base, '/api/models');
  assert.equal(anon.status, 401);
});
