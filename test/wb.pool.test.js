import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startStub } from './helpers/stub.mjs';
import { startGateway, seedDb } from './helpers/gateway.mjs';
import { createWorkbuddyPool, classifyUpstreamError } from '../pools/workbuddy/index.mjs';

const CHAT_PATH = '/v2/chat/completions';

function openAiSse(chunks) {
  return chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n';
}
const OK_SSE = openAiSse([
  { id: 'c', object: 'chat.completion.chunk', model: 'glm-5.2', choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' }, finish_reason: null }] },
  { id: 'c', object: 'chat.completion.chunk', model: 'glm-5.2', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
]);

const ACCOUNT = (id = 'wb-1', uid = '1', jwt = 'at-1') => ({
  id,
  uid,
  jwt,
  refreshToken: `rt-${id}`,
  expiresAt: Date.now() + 3_600_000,
  enterpriseId: 'ent-9',
  state: 'ok',
  weight: 10,
  enabled: true,
});

function makePool(stub, overrides = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ugw-wb-pool-'));
  return createWorkbuddyPool({
    accounts: overrides.accounts ?? [ACCOUNT()],
    region: overrides.region ?? 'cn',
    config: {
      dataDir,
      endpoint: stub.origin,
      endpoints: {
        chat: `${stub.origin}${CHAT_PATH}`,
        auth: stub.origin,
        biz: `${stub.origin}`,
        models: `${stub.origin}`,
      },
      maxAttempts: overrides.maxAttempts ?? 3,
      // 三 realm 全指到桩（缺省会打真实上游域名）
      realmBases: [stub.origin, `${stub.origin}/r2`, `${stub.origin}/r3`],
      ...(overrides.config ?? {}),
    },
  });
}

test('refresh patch 同步落盘：accounts.json 整组更新新 accessToken/refreshToken', async (t) => {
  const stub = await startStub(t, (req, res) => {
    if (req.url === '/v2/plugin/auth/token/refresh') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: { data: { accessToken: 'at-new', refreshToken: 'rt-new' } } }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(OK_SSE);
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ugw-wb-disk-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const accountsFile = path.join(dir, 'accounts.json');
  fs.writeFileSync(accountsFile, JSON.stringify([{ ...ACCOUNT('wb-1', '1'), jwt: 'at-old', expiresAt: 0 }]));

  const pool = makePool(stub, {
    maxAttempts: 1,
    accounts: [{ ...ACCOUNT('wb-1', '1'), jwt: 'at-old', expiresAt: 0 }],
    config: { accountsFile },
  });
  const { db, full } = seedDb({ name: 'dev', pools: ['workbuddy-cn'] });
  const { base } = await startGateway(t, { pools: [pool], db });

  const res = await fetch(`${base}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': full },
    body: JSON.stringify({ model: 'workbuddy-cn/glm-5.2', max_tokens: 64, messages: [{ role: 'user', content: 'hi' }] }),
  });
  assert.equal(res.status, 200);
  const persisted = JSON.parse(fs.readFileSync(accountsFile, 'utf8'));
  assert.equal(persisted[0].jwt, 'at-new', '新 accessToken 落盘');
  assert.equal(persisted[0].refreshToken, 'rt-new', '新 refreshToken 整组落盘');
});

test('classifyUpstreamError：6004 → modelLevel + resetAt；402 → 12h quota_exhausted；401/403 → auth；5xx → server', () => {
  const cls = classifyUpstreamError(429, JSON.stringify({ code: 6004, msg: '将在 2026-09-22 09:46:39 UTC+8 重置' }));
  assert.equal(cls.kind, 'client');
  assert.equal(cls.modelLevel, true);
  assert.equal(cls.retryable, false);
  assert.equal(cls.resetAt, Date.UTC(2026, 8, 22, 1, 46, 39));

  const q = classifyUpstreamError(402, '{"code":402,"msg":"insufficient credits"}');
  assert.equal(q.kind, 'quota_exhausted');
  assert.equal(q.retryable, true);

  assert.equal(classifyUpstreamError(401, '').kind, 'auth');
  assert.equal(classifyUpstreamError(403, '').kind, 'auth');
  assert.equal(classifyUpstreamError(500, 'oops').kind, 'server');
  assert.equal(classifyUpstreamError(400, 'bad').kind, 'client');
});

test('6004：注册 (账号,模型) 窗口，后续请求 fast-fail 不打上游；同账号其它模型不受影响', async (t) => {
  let chatHits = 0;
  const stub = await startStub(t, (req, res) => {
    if (req.url === CHAT_PATH) chatHits++;
    res.writeHead(429, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ code: 6004, msg: '调用过于频繁，将在 2099-01-01 00:00:00 UTC+8 重置。您也可以切换其他模型继续使用' }));
  });
  const accounts = [ACCOUNT('wb-1'), ACCOUNT('wb-2')];
  const pool = makePool(stub, { accounts, maxAttempts: 3 });
  const { db, full } = seedDb({ name: 'dev', pools: ['workbuddy-cn'] });
  const { base } = await startGateway(t, { pools: [pool], db });

  const res = await fetch(`${base}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': full },
    body: JSON.stringify({ model: 'workbuddy-cn/glm-5.2', max_tokens: 64, messages: [{ role: 'user', content: 'hi' }] }),
  });
  const body = await res.json();
  assert.equal(res.status, 429);
  assert.match(body.error.message, /2099-01-01/, '错误文案带声明式重置时间');
  assert.match(body.error.message, /切换其他模型/);
  assert.doesNotMatch(body.error.message, /429/);
  assert.equal(chatHits, 2, '两个账号各真打一次上游（6004 不计入凭证冷却）');

  // 账号不冷却：仍是 ok
  for (const acc of pool.scheduler.accounts) {
    assert.equal(acc.state, 'ok');
    assert.equal(acc.cooldownUntil, 0, '模型级限流不是凭证级，账号不冷却');
  }

  // 第二次请求：注册表已登记 → 全部 fast-fail，不打上游
  const hitsBefore = chatHits;
  const res2 = await fetch(`${base}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': full },
    body: JSON.stringify({ model: 'workbuddy-cn/glm-5.2', max_tokens: 64, messages: [{ role: 'user', content: 'hi' }] }),
  });
  assert.equal(res2.status, 429);
  assert.equal(chatHits, hitsBefore, 'fast-fail 不打上游');
});

test('6004 只影响该模型：同账号其它模型照常打上游', async (t) => {
  const stub = await startStub(t, (req, res, rec) => {
    const body = JSON.parse(rec.body || '{}');
    if (body.model === 'glm-5.2') {
      res.writeHead(429, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ code: 6004, msg: '将在 2099-01-01 00:00:00 UTC+8 重置' }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(OK_SSE);
  });
  const pool = makePool(stub, { maxAttempts: 1 });
  const { db, full } = seedDb({ name: 'dev', pools: ['workbuddy-cn'] });
  const { base } = await startGateway(t, { pools: [pool], db });

  const res = await fetch(`${base}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': full },
    body: JSON.stringify({ model: 'workbuddy-cn/glm-5.2', max_tokens: 64, messages: [{ role: 'user', content: 'hi' }] }),
  });
  assert.equal(res.status, 429);

  const res2 = await fetch(`${base}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': full },
    body: JSON.stringify({ model: 'workbuddy-cn/kimi-k3-1', max_tokens: 64, messages: [{ role: 'user', content: 'hi' }] }),
  });
  assert.equal(res2.status, 200, '同账号其它模型健康');
});

test('HTTP 401 → needs_login；402 → 12h 冷却（cooldownKind=quota_exhausted）', async (t) => {
  const t0 = Date.now();
  const stub = await startStub(t, (req, res) => {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end('{"code":401,"msg":"token expired"}');
  });
  const pool = makePool(stub, { maxAttempts: 1 });
  const { db, full } = seedDb({ name: 'dev', pools: ['workbuddy-cn'] });
  const { base } = await startGateway(t, { pools: [pool], db });

  const res = await fetch(`${base}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': full },
    body: JSON.stringify({ model: 'workbuddy-cn/glm-5.2', max_tokens: 64, messages: [{ role: 'user', content: 'hi' }] }),
  });
  assert.equal(res.status, 401);
  assert.equal(pool.scheduler.accounts[0].state, 'needs_login');

  // 402
  const stub2 = await startStub(t, (req, res) => {
    res.writeHead(402, { 'content-type': 'application/json' });
    res.end('{"code":402,"msg":"insufficient credits"}');
  });
  const pool2 = makePool(stub2, { maxAttempts: 1 });
  const { db: db2, full: full2 } = seedDb({ name: 'dev', pools: ['workbuddy-cn'] });
  const { base: base2 } = await startGateway(t, { pools: [pool2], db: db2 });
  const res2 = await fetch(`${base2}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': full2 },
    body: JSON.stringify({ model: 'workbuddy-cn/glm-5.2', max_tokens: 64, messages: [{ role: 'user', content: 'hi' }] }),
  });
  assert.equal(res2.status, 429);
  const acc = pool2.scheduler.accounts[0];
  assert.equal(acc.cooldownKind, 'quota_exhausted');
  assert.ok(acc.cooldownUntil >= t0 + 12 * 3_600_000, '12h 冷却');
});

test('两池名 workbuddy / workbuddy-cn 进 /v1/models 与 /health（无账号也出现）', async (t) => {
  const stub = await startStub(t, (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: { data: { models: [] } } }));
  });
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ugw-wb-boot-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const pGlobal = createWorkbuddyPool({ accounts: [], region: 'global', config: { dataDir, endpoint: stub.origin, endpoints: { chat: `${stub.origin}${CHAT_PATH}`, biz: stub.origin, models: stub.origin }, realmBases: [stub.origin, stub.origin, stub.origin] } });
  const pCn = createWorkbuddyPool({ accounts: [], region: 'cn', config: { dataDir, endpoint: stub.origin, endpoints: { chat: `${stub.origin}${CHAT_PATH}`, biz: stub.origin, models: stub.origin }, realmBases: [stub.origin, stub.origin, stub.origin] } });
  const { db, full } = seedDb({ name: 'dev', pools: ['workbuddy', 'workbuddy-cn'] });
  const { base } = await startGateway(t, { pools: [pGlobal, pCn], db });

  const health = await (await fetch(`${base}/health`)).json();
  assert.ok(health.pools.includes('workbuddy'));
  assert.ok(health.pools.includes('workbuddy-cn'));

  const models = await (await fetch(`${base}/v1/models`, { headers: { 'x-api-key': full } })).json();
  const ids = models.data.map((m) => m.id);
  // 双路失败（空表）→ 静态降级表
  assert.ok(ids.some((id) => id.startsWith('workbuddy/')), 'global 池有模型');
  assert.ok(ids.some((id) => id.startsWith('workbuddy-cn/')), 'cn 池有模型');
  assert.equal(pCn.catalog.source, 'static');
});

test('模型双路探测：单路失败降级另一路；nonChatModel 过滤；两代能力字段兼容', async (t) => {
  const MODELS = [
    { id: 'glm-5.2', name: 'GLM-5.2', ContextLength: 168000, MaxCompletionTokens: 32000, SupportsToolCall: true },
    { id: 'nes-1.2', name: 'NES' },
    { id: 'tiny', name: 'Tiny', maxOutputTokens: 256 },
    { id: 'painter', name: 'Painter', tags: ['text-to-image'] },
    { id: 'thinker', name: 'Thinker', contextWindow: 200000, maxOutputTokens: 8192, reasoning: { supportedEfforts: ['low', 'high'] } },
  ];
  const stub = await startStub(t, (req, res) => {
    if (req.url.startsWith('/console/enterprises/ent-9/config/models')) {
      res.writeHead(500);
      res.end('boom');
      return;
    }
    if (req.url.endsWith('/v3/config')) {
      assert.equal(req.headers['user-agent'], 'CodeBuddyIDE/4.12.0 CodeBuddy/4.12.0', 'UA 敏感');
      assert.equal(req.headers['x-requested-with'], 'XMLHttpRequest');
      assert.equal(req.headers['x-product'], 'SaaS');
      assert.equal(req.headers['x-codebuddy-request'], '1');
      res.end(JSON.stringify({ code: 0, data: { models: MODELS } }));
      return;
    }
    res.end('{}');
  });
  const pool = makePool(stub, { maxAttempts: 1 });
  assert.equal(await pool.refreshModels(), true, '企业路失败、v3 路 ok → 降级成功');
  assert.equal(pool.catalog.source, 'v3');

  const ids = pool.models().map((m) => m.id);
  assert.ok(ids.includes('glm-5.2'));
  assert.ok(!ids.includes('nes-1.2'), 'nes- 前缀过滤');
  assert.ok(!ids.includes('tiny'), 'maxOutput<=256 过滤');
  assert.ok(!ids.includes('painter'), 'text-to-image 过滤');
  const glm = pool.models().find((m) => m.id === 'glm-5.2');
  assert.equal(glm.context_window, 168000, '一代字段 ContextLength');
  assert.equal(glm.max_tokens, 32000, '一代字段 MaxCompletionTokens');
  const thinker = pool.models().find((m) => m.id === 'thinker');
  assert.equal(thinker.context_window, 200000, '二代字段 contextWindow');
  assert.equal(thinker.supports_thinking, true, 'reasoning.supportedEfforts → thinking');
});

test('企业端点排序权威 + v3 补能力；企业路独有模型在前列', async (t) => {  const stub = await startStub(t, (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    if (req.url.startsWith('/console/enterprises/ent-9/config/models')) {
      res.end(JSON.stringify({ data: { data: [{ id: 'ent-only', name: 'Ent Only' }, { id: 'shared', name: 'Shared' }] } }));
      return;
    }
    if (req.url.endsWith('/v3/config')) {
      res.end(JSON.stringify({ data: { models: [{ id: 'shared', name: 'Shared', ContextLength: 99000 }, { id: 'v3-only', name: 'V3 Only' }] } }));
      return;
    }
    res.end('{}');
  });
  const pool = makePool(stub);
  await pool.refreshModels();
  const ids = pool.models().map((m) => m.id);
  assert.deepEqual(ids, ['ent-only', 'shared', 'v3-only'], '企业排序权威，v3 独有追加');
  assert.equal(pool.models().find((m) => m.id === 'shared').context_window, 99000, 'v3 补能力');
  assert.equal(pool.catalog.source, 'enterprise+v3');
});

test('三 realm 联合：不同 realm 返回不同模型集 → 按 realm 顺序合并；单 realm 500 降级其它 realm', async (t) => {
  const stub = await startStub(t, (req, res) => {
    if (req.url.startsWith('/r2/')) {
      res.writeHead(500);
      res.end('boom');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    if (req.url.startsWith('/r1/')) {
      res.end(JSON.stringify({ data: { models: [{ id: 'realm1-a', name: 'A1' }, { id: 'shared', name: 'Shared', ContextLength: 100 }] } }));
      return;
    }
    if (req.url.startsWith('/r3/')) {
      res.end(JSON.stringify({ data: { models: [{ id: 'shared', name: 'Shared' }, { id: 'realm3-c', name: 'C3' }] } }));
      return;
    }
    res.end('{}');
  });
  const pool = createWorkbuddyPool({
    accounts: [{ ...ACCOUNT('wb-1'), enterpriseId: '' }],
    region: 'cn',
    config: {
      endpoint: stub.origin,
      endpoints: { chat: `${stub.origin}${CHAT_PATH}`, auth: stub.origin, biz: stub.origin, models: stub.origin },
      realmBases: [`${stub.origin}/r1`, `${stub.origin}/r2`, `${stub.origin}/r3`],
    },
  });
  assert.equal(await pool.refreshModels(), true, 'r2 失败，r1+r3 成功 → 降级成功');
  const ids = pool.models().map((m) => m.id);
  assert.deepEqual(ids, ['realm1-a', 'shared', 'realm3-c'], 'r1 先、r3 独有追加；shared 补 r1 能力');
  assert.equal(pool.models().find((m) => m.id === 'shared').context_window, 100);
  assert.equal(pool.catalog.source, 'v3');

  const v3Hits = stub.requests.filter((r) => r.url.endsWith('/v3/config'));
  assert.equal(v3Hits.length, 3, '三 realm 并发各探测一次');
  for (const base of ['/r1', '/r2', '/r3']) {
    const hit = v3Hits.find((r) => r.url === `${base}/v3/config`);
    assert.ok(hit, `realm ${base} 有请求`);
    assert.equal(hit.headers['x-domain'], new URL(stub.origin).host, 'X-Domain 带对应 realm 域名');
  }
});

test('maxOutput 两代别名：OutputTokenLimit <=256 同样过滤；OutputTokenLimit 作 max_tokens 透出', async (t) => {
  const stub = await startStub(t, (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    if (req.url.endsWith('/v3/config')) {
      res.end(JSON.stringify({
        data: {
          models: [
            { id: 'tiny-old', name: 'TinyOld', OutputTokenLimit: 128 },
            { id: 'normal', name: 'Normal', OutputTokenLimit: 8192 },
          ],
        },
      }));
      return;
    }
    res.end('{}');
  });
  const pool = createWorkbuddyPool({
    accounts: [{ ...ACCOUNT('wb-1'), enterpriseId: '' }],
    region: 'cn',
    config: {
      endpoint: stub.origin,
      endpoints: { chat: `${stub.origin}${CHAT_PATH}`, auth: stub.origin, biz: stub.origin, models: stub.origin },
      realmBases: [stub.origin, stub.origin, stub.origin],
    },
  });
  await pool.refreshModels();
  const ids = pool.models().map((m) => m.id);
  assert.ok(!ids.includes('tiny-old'), 'OutputTokenLimit<=256 过滤（§107 别名）');
  assert.equal(pool.models().find((m) => m.id === 'normal').max_tokens, 8192, 'OutputTokenLimit → max_tokens');
});
