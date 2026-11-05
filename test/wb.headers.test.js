import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { authHeaders, loginHeaders, machineIdFor, loadIdentitySeed, domainFor } from '../pools/workbuddy/headers.mjs';
import { ENDPOINT_CN, IDE_VERSION, PRODUCT_VERSION } from '../pools/workbuddy/constants.mjs';

const ACC = () => ({
  id: 'wb-10001',
  uid: 10001,
  jwt: 'at-1',
  refreshToken: 'rt-1',
  enterpriseId: 'ent-9',
  departmentInfo: 'dept-x',
});

test('authHeaders 逐头：IDE 族 + Product-Code + Bearer + 企业/部门 + X-Domain', () => {
  const h = authHeaders(ACC(), { endpoint: ENDPOINT_CN, seed: 's1' });
  assert.equal(h['User-Agent'], 'Mozilla/5.0 (compatible; Genie-IDE/1.0)');
  assert.equal(h['X-Product-Code'], 'codebuddy');
  assert.equal(h['X-IDE-Type'], 'vscode');
  assert.equal(h['X-IDE-Name'], 'Visual Studio Code');
  assert.equal(h['X-IDE-Version'], '1.70.2');
  assert.equal(h['X-Product-Version'], PRODUCT_VERSION);
  assert.equal(h['X-User-Id'], '10001');
  assert.equal(h['Authorization'], 'Bearer at-1');
  assert.equal(h['X-Enterprise-Id'], 'ent-9');
  assert.equal(h['X-Tenant-Id'], 'ent-9');
  assert.equal(h['X-Department-Info'], 'dept-x');
  assert.equal(h['X-Domain'], 'copilot.tencent.com', 'token 无 domain 时回退端点 host');
  assert.equal(h['X-IDE-Version'], IDE_VERSION);
  assert.ok(h['X-Machine-Id']);
  // refresh 请求才带 X-Refresh-Token
  assert.equal(h['X-Refresh-Token'], undefined);
  const rh = authHeaders(ACC(), { access: false, refresh: true, endpoint: ENDPOINT_CN, seed: 's1' });
  assert.equal(rh['Authorization'], undefined);
  assert.equal(rh['X-Refresh-Token'], 'rt-1');
});

test('X-Domain：token.domain 优先于端点 host；无 domain 且无端点则省略', () => {
  const h = authHeaders({ ...ACC(), domain: 'my.corp' }, { endpoint: ENDPOINT_CN });
  assert.equal(h['X-Domain'], 'my.corp');
  const h2 = authHeaders({ jwt: 'at' });
  assert.equal(h2['X-Domain'], undefined);
  assert.equal(domainFor({ domain: 'a.b' }, 'https://x.cn'), 'a.b');
  assert.equal(domainFor({}, 'https://copilot.tencent.com'), 'copilot.tencent.com');
});

test('machineIdFor 确定性：同 seed 同值、异 seed 异值、uuid v5 形状', () => {
  const a = machineIdFor('seed-x');
  const b = machineIdFor('seed-x');
  const c = machineIdFor('seed-y');
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test('loadIdentitySeed：workbuddy-cn / workbuddy-global 各自独立、持久、确定性', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ugw-wb-id-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cn1 = loadIdentitySeed(dir, 'cn');
  const cn2 = loadIdentitySeed(dir, 'cn');
  const g1 = loadIdentitySeed(dir, 'global');
  assert.equal(cn1, cn2);
  assert.notEqual(cn1, g1);
  assert.ok(fs.existsSync(path.join(dir, 'identity', 'workbuddy-cn.json')));
  assert.ok(fs.existsSync(path.join(dir, 'identity', 'workbuddy-global.json')));
  // 确定性：同 seed 同账号同 machineId
  const h1 = authHeaders({ id: 'wb-1', jwt: 'j' }, { seed: cn1, endpoint: ENDPOINT_CN });
  const h2 = authHeaders({ id: 'wb-1', jwt: 'j' }, { seed: loadIdentitySeed(dir, 'cn'), endpoint: ENDPOINT_CN });
  assert.equal(h1['X-Machine-Id'], h2['X-Machine-Id']);
});

test('loginHeaders：no_auth 四连 + 基础头，不带 Authorization', () => {
  const h = loginHeaders({}, { endpoint: ENDPOINT_CN });
  assert.equal(h['X-No-Authorization'], 'true');
  assert.equal(h['X-No-User-Id'], 'true');
  assert.equal(h['X-No-Enterprise-Id'], 'true');
  assert.equal(h['X-No-Department-Info'], 'true');
  assert.equal(h['X-Product-Code'], 'codebuddy');
  assert.equal(h['Authorization'], undefined);
});
