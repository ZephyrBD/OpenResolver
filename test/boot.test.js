import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { boot } from '../boot.mjs';

function tmpData(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ugw-boot-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('boot wires a gateway with the zcode pool and serves /health', async (t) => {
  const dataDir = tmpData(t);
  const { server } = boot({ env: { UGW_DATA_DIR: dataDir, PORT: '0' }, log: () => {} });
  const port = await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
  t.after(() => new Promise((r) => server.close(r)));

  const health = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
  assert.deepEqual(health.pools, ['zcode', 'qoder', 'qoder-cn', 'trae', 'workbuddy', 'workbuddy-cn', 'codearts']);

  const models = await (await fetch(`http://127.0.0.1:${port}/v1/models`)).json();
  const ids = models.data.map((m) => m.id);
  assert.deepEqual(
    ids.filter((id) => id.startsWith('zcode/')),
    ['zcode/GLM-5.3', 'zcode/GLM-5.3-Flash'],
  );
  assert.ok(ids.some((id) => id.startsWith('qoder/')), '无账号时 Qoder 池名也要出现');
  assert.ok(ids.some((id) => id.startsWith('qoder-cn/')), '无账号时 Qoder CN 池名也要出现');
  assert.ok(fs.existsSync(path.join(dataDir, 'pools', 'zcode')), '数据目录应初始化');
});

test('boot passes claimers into the panel gateway (M8：claim 路由不能 501)', async (t) => {
  const dataDir = tmpData(t);
  const { server, panel, codearts } = boot({ env: { UGW_DATA_DIR: dataDir, PORT: '0' }, log: () => {} });
  t.after(() => new Promise((r) => server.close(r)));
  // 每个池都要有 claimer 实例，且面板拿到的是同一份引用
  assert.equal(Object.keys(panel.claimers ?? {}).length, 7, '7 个池各一个 claimer');
  for (const poolName of ['zcode', 'qoder', 'qoder-cn', 'trae', 'workbuddy', 'workbuddy-cn', 'codearts']) {
    assert.ok(panel.claimers?.[poolName], `池 ${poolName} 缺 claimer`);
    assert.ok(typeof panel.claimers[poolName].run === 'function', `池 ${poolName} 的 claimer 没有 run()`);
  }
  assert.equal(typeof codearts?.credsOf, 'function', 'codearts 池须暴露 credsOf（claimer 领取前刷新 STS）');
  assert.ok(panel.claimScheduler, 'panel 应拿到 claimScheduler 引用');
});

test('boot writes pool-settings.json with defaults when the file is missing', (t) => {
  const dataDir = tmpData(t);
  const { server } = boot({ env: { UGW_DATA_DIR: dataDir, UGW_TOPN: '4' }, log: () => {} });
  t.after(() => new Promise((r) => server.close(r)));

  const file = path.join(dataDir, 'pool-settings.json');
  assert.ok(fs.existsSync(file), '首次启动必须落一份设置文件');
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(saved.topN, 4, '环境变量作为首次默认值');
  assert.equal(saved.maxInFlight, 5);
  assert.equal(saved.stickyTtlMs, 1_800_000);
});

test('an existing pool-settings.json wins over the environment on boot', (t) => {
  const dataDir = tmpData(t);
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'pool-settings.json'), JSON.stringify({ topN: 2, maxAttempts: 1 }));
  const { server, poolSettings } = boot({ env: { UGW_DATA_DIR: dataDir, UGW_TOPN: '9' }, log: () => {} });
  t.after(() => new Promise((r) => server.close(r)));

  assert.equal(poolSettings.topN, 2);
  assert.equal(poolSettings.maxAttempts, 1);
});
