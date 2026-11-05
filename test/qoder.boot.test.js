import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { boot } from '../boot.mjs';

function tmpData(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ugw-qboot-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('boot 组装 qoder / qoder-cn 两池：无账号也出现在 /v1/models 与 /health', async (t) => {
  const dataDir = tmpData(t);
  const { server, qoder, qoderCn } = boot({ env: { UGW_DATA_DIR: dataDir, PORT: '0' }, log: () => {} });
  const port = await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
  t.after(() => new Promise((r) => server.close(r)));

  const health = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
  assert.deepEqual(health.pools, ['zcode', 'qoder', 'qoder-cn', 'trae', 'workbuddy', 'workbuddy-cn', 'codearts']);

  const models = await (await fetch(`http://127.0.0.1:${port}/v1/models`)).json();
  const ids = models.data.map((m) => m.id);
  assert.ok(ids.some((id) => id.startsWith('qoder/')), ids.join(','));
  assert.ok(ids.some((id) => id.startsWith('qoder-cn/')), ids.join(','));

  assert.equal(qoder.name, 'qoder');
  assert.equal(qoderCn.name, 'qoder-cn');
  assert.ok(fs.existsSync(path.join(dataDir, 'pools', 'qoder')), 'global 池数据目录应初始化');
  assert.ok(fs.existsSync(path.join(dataDir, 'pools', 'qoder-cn')), 'cn 池数据目录应初始化');
  assert.ok(fs.existsSync(path.join(dataDir, 'identity', 'qoder.json')), 'identity seed 应首次生成');
});

test('boot：model/list 缓存缺失时静态兜底模型带 degraded 标记', async (t) => {
  const dataDir = tmpData(t);
  const { qoder } = boot({ env: { UGW_DATA_DIR: dataDir, PORT: '0' }, log: () => {} });
  const models = qoder.models();
  assert.ok(models.length > 0);
  assert.ok(models.every((m) => m.degraded === true), '无缓存 → 静态兜底 degraded');
  assert.ok(models.some((m) => m.id === 'Auto'));
  assert.ok(models.every((m) => m.supports_tools === true));
  assert.ok(models.every((m) => m.context_window >= 200_000));
});

test('boot：identity seed 复用（二次启动不换 seed）', (t) => {
  const dataDir = tmpData(t);
  const first = fs.existsSync(path.join(dataDir, 'identity', 'qoder.json'));
  boot({ env: { UGW_DATA_DIR: dataDir, PORT: '0' }, log: () => {} });
  const seed1 = JSON.parse(fs.readFileSync(path.join(dataDir, 'identity', 'qoder.json'), 'utf8')).seed;
  boot({ env: { UGW_DATA_DIR: dataDir, PORT: '0' }, log: () => {} });
  const seed2 = JSON.parse(fs.readFileSync(path.join(dataDir, 'identity', 'qoder.json'), 'utf8')).seed;
  assert.equal(first, false);
  assert.equal(seed1, seed2);
});
