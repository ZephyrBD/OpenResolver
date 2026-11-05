// models.meta.test.js — 五个池的 models() 元数据契约：
// 每条模型必须有非空 id / display_name / upstream_model、布尔 supports_tools / supports_thinking、
// 数字或 null 的 context_window；zcode 的 upstream_model === id，qoder 的 upstream_model === 上游 key。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createZcodePool } from '../pools/zcode/index.mjs';
import { createModelCatalog } from '../pools/qoder/models.mjs';
import { createTraePool } from '../pools/trae/index.mjs';
import { createWorkbuddyPool } from '../pools/workbuddy/index.mjs';
import { createCodeartsPool } from '../pools/codearts/index.mjs';

const PROFILE = {
  system: [{ type: 'text', text: 'OFFICIAL SYSTEM' }],
  max_tokens: 128000,
  tool_choice: { type: 'auto' },
  thinking: { type: 'enabled' },
  output_config: { effort: 'low' },
};

function tmpDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function assertModelShape(models, label) {
  assert.ok(Array.isArray(models) && models.length > 0, `${label}: models 非空`);
  for (const m of models) {
    assert.equal(typeof m.id, 'string', `${label}: id 是字符串`);
    assert.ok(m.id.length > 0, `${label}: id 非空（${JSON.stringify(m)}）`);
    assert.ok(typeof m.display_name === 'string' && m.display_name.length > 0, `${label}: display_name 非空（${m.id}）`);
    assert.ok(typeof m.upstream_model === 'string' && m.upstream_model.length > 0, `${label}: upstream_model 非空（${m.id}）`);
    assert.equal(typeof m.supports_tools, 'boolean', `${label}: supports_tools 布尔（${m.id}）`);
    assert.equal(typeof m.supports_thinking, 'boolean', `${label}: supports_thinking 布尔（${m.id}）`);
    assert.ok(
      m.context_window === null || (typeof m.context_window === 'number' && Number.isFinite(m.context_window)),
      `${label}: context_window 数字或 null（${m.id}）`,
    );
  }
}

test('zcode: models() 每条带 upstream_model === id 且 verified: true', () => {
  const pool = createZcodePool({ accounts: [], profile: PROFILE, config: {} });
  const models = pool.models();
  assertModelShape(models, 'zcode');
  for (const m of models) {
    assert.equal(m.upstream_model, m.id);
    assert.equal(m.verified, true);
  }
});

test('qoder: 静态兜底 upstream_model === 上游 key', (t) => {
  const catalog = createModelCatalog({ mode: 'cn', cacheFile: path.join(tmpDir(t, 'ugw-qm-'), 'models-cache.json') });
  const models = catalog.models();
  assertModelShape(models, 'qoder-static');
  const gm = models.find((m) => m.id === 'GLM-5.2');
  assert.ok(gm, 'cn 兜底表有 GLM-5.2');
  assert.equal(gm.key, 'gm51model');
  assert.equal(gm.upstream_model, 'gm51model');
});

test('qoder: 缓存路径 upstream_model === 上游 key 且保留 key 字段', (t) => {
  const dir = tmpDir(t, 'ugw-qmc-');
  const cacheFile = path.join(dir, 'models-cache.json');
  fs.writeFileSync(
    cacheFile,
    JSON.stringify({
      updatedAt: Date.now(),
      models: [
        { id: 'Qwen3.7-Max', display_name: 'Qwen3.7-Max', key: 'qmodel_latest', is_reasoning: true, context_window: 262144 },
      ],
      configs: {},
    }),
  );
  const catalog = createModelCatalog({ mode: 'cn', cacheFile });
  const models = catalog.models();
  assertModelShape(models, 'qoder-cache');
  assert.equal(models[0].key, 'qmodel_latest');
  assert.equal(models[0].upstream_model, 'qmodel_latest');
});

test('trae: models() 带 upstream_model === id、verified 与数字 context_window', () => {
  const pool = createTraePool({
    accounts: [{ id: 'trae-01', jwt: 'jwt-1', refreshToken: 'rt-1', uid: '1', state: 'ok', enabled: true }],
    config: {},
  });
  const models = pool.models();
  assertModelShape(models, 'trae');
  for (const m of models) {
    assert.equal(m.upstream_model, m.id);
    assert.equal(typeof m.verified, 'boolean');
  }
});

test('workbuddy: models() 带 upstream_model === id 与 verified 标志', (t) => {
  const dir = tmpDir(t, 'ugw-wbm-');
  const pool = createWorkbuddyPool({
    accounts: [{ id: 'wb-1', uid: '1', jwt: 'at-1', refreshToken: 'rt-1', state: 'ok', enabled: true }],
    region: 'cn',
    config: { dataDir: dir },
  });
  const models = pool.models();
  assertModelShape(models, 'workbuddy');
  for (const m of models) assert.equal(m.verified, false); // 静态降级表
});

test('codearts: models() 带 upstream_model === id 且 context_window 数字或 null', (t) => {
  const dir = tmpDir(t, 'ugw-cam-');
  const pool = createCodeartsPool({
    accounts: [{ id: 'ca-1', userId: 'u1', state: 'ok', enabled: true }],
    config: { dataDir: dir },
  });
  const models = pool.models();
  assertModelShape(models, 'codearts');
  const seeded = models.find((m) => m.id === 'glm-5.3');
  assert.ok(seeded, '冷启动种子在静态降级表里');
  assert.equal(seeded.benefit, false, '免费权益通道已下线，种子不再标记 benefit');
});
