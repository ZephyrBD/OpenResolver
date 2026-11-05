import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startStub } from './helpers/stub.mjs';
import { startGateway, seedDb } from './helpers/gateway.mjs';
import { createQoderPool, classifyUpstreamError, anthropicMessageFromEvents } from '../pools/qoder/index.mjs';
import { createQoderQuotaCache } from '../pools/qoder/quota.mjs';
import { credentialsFromPat, createTokenManager } from '../pools/qoder/auth.mjs';
import { qoderStdAlphabet, qoderCustomAlphabet } from '../pools/qoder/encode.mjs';
import { chatUrl } from '../pools/qoder/region.mjs';
import crypto from 'node:crypto';

const CHAT_PATH = '/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1';

function tmpFile(t, name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ugw-qoder-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, name);
}

/** 反向解码 Qoder 编码体（测试用）：重排逆序 + 自定义字母表逆映射 + base64。 */
function decodeQoderBody(buf) {
  const n = buf.length;
  const a = Math.floor(n / 3);
  const std = Buffer.alloc(n);
  let dst = 0;
  for (let i = n - a; i < n; i++) std[dst++] = buf[i]; // head
  for (let i = a; i < n - a; i++) std[dst++] = buf[i]; // middle
  for (let i = 0; i < a; i++) std[dst++] = buf[i]; // tail
  const reverse = new Map();
  for (let i = 0; i < qoderStdAlphabet.length; i++) reverse.set(qoderCustomAlphabet[i], qoderStdAlphabet[i]);
  reverse.set('$', '=');
  let b64 = '';
  for (let i = 0; i < n; i++) b64 += reverse.get(String.fromCharCode(std[i])) ?? String.fromCharCode(std[i]);
  return JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
}

function envelopeLine(inner) {
  return `data: ${JSON.stringify({ statusCodeValue: 200, body: typeof inner === 'string' ? inner : JSON.stringify(inner) })}\n\n`;
}
const DONE_LINE = `data: ${JSON.stringify({ statusCodeValue: 200, body: '[DONE]' })}\n\n`;

function chatChunk(delta, extra = {}) {
  return { id: 'chatcmpl-9', model: 'qmodel_latest', choices: [{ index: 0, delta, finish_reason: extra.finish_reason ?? null }], ...(extra.usage ? { usage: extra.usage } : {}) };
}

const DOUBLE_SSE =
  envelopeLine(chatChunk({ content: 'Hello' })) +
  envelopeLine(chatChunk({ content: ' world' }, { finish_reason: 'stop', usage: { prompt_tokens: 10, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 3 } } })) +
  DONE_LINE;

const ACCOUNT = () => ({
  id: 'q-01',
  label: 'a1',
  email: 'a@x.com',
  pat: 'pt-1',
  jobToken: 'job-1',
  jobRefreshToken: 'r1',
  userID: 'u-1',
  machineID: 'mach-1',
  jobTokenExpiresAt: Date.now() + 3_600_000,
  weight: 10,
  enabled: true,
});

function makePool(stub, overrides = {}) {
  return createQoderPool({
    accounts: overrides.accounts ?? [ACCOUNT()],
    region: overrides.region ?? 'global',
    config: {
      endpoints: {
        chat: `${stub.origin}${CHAT_PATH}`,
        modelList: `${stub.origin}/algo/api/v2/model/list?Encode=1`,
        auth: `${stub.origin}/auth`,
        quota: `${stub.origin}/quota`,
      },
      modelsCacheFile: tmpFile(stub.t, 'models-cache.json'),
      maxAttempts: overrides.maxAttempts ?? 2,
      ...(overrides.config ?? {}),
    },
  });
}

test('端到端非流式 /v1/messages：上游收到编码体 + COSY 头，客户端拿到 Anthropic JSON', async (t) => {
  const stub = await startStub(t, (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(DOUBLE_SSE);
  });
  const pool = makePool({ ...stub, t });
  const { db, full } = seedDb({ name: 'dev', pools: ['qoder'] });
  const { base } = await startGateway(t, { pools: [pool], db });

  const res = await fetch(`${base}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': full },
    body: JSON.stringify({ model: 'qoder/Qwen3.7-Max', max_tokens: 64, messages: [{ role: 'user', content: 'hi' }] }),
  });
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.equal(body.type, 'message');
  assert.equal(body.role, 'assistant');
  assert.deepEqual(body.content, [{ type: 'text', text: 'Hello world' }]);
  assert.equal(body.stop_reason, 'end_turn');
  assert.deepEqual(body.usage, { input_tokens: 7, output_tokens: 2 });

  const rec = stub.requests[0];
  assert.equal(rec.url, CHAT_PATH);
  assert.equal(rec.headers['x-model-key'], 'qmodel_latest');
  assert.equal(rec.headers['x-model-source'], 'system');
  assert.equal(rec.headers['cosy-user'], 'u-1');
  assert.equal(rec.headers['accept'], 'text/event-stream');
  assert.equal(rec.headers['accept-encoding'], 'identity');
  assert.equal(rec.headers['cosy-bodyhash'], crypto.createHash('md5').update(Buffer.from(rec.body, 'binary')).digest('hex'));

  const raw = Buffer.from(rec.body, 'binary');
  const payload = decodeQoderBody(raw);
  assert.equal(payload.stream, true);
  assert.equal(payload.messages[0].content, 'hi');
  assert.equal(payload.parameters.enable_thinking, false);
  assert.equal(payload.model_config.key, 'qmodel_latest');
});

test('端到端流式：上游回双层 SSE → 客户端收到 Anthropic SSE', async (t) => {
  const stub = await startStub(t, (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(DOUBLE_SSE);
  });
  const pool = makePool({ ...stub, t });
  const { db, full } = seedDb({ name: 'dev', pools: ['qoder'] });
  const { base } = await startGateway(t, { pools: [pool], db });

  const res = await fetch(`${base}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': full },
    body: JSON.stringify({ model: 'qoder/Qwen3.7-Max', max_tokens: 64, stream: true, messages: [{ role: 'user', content: 'hi' }] }),
  });

  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/event-stream/);
  const text = await res.text();
  const types = [...text.matchAll(/^event: (.+)$/gm)].map((m) => m[1]);
  assert.deepEqual(types, ['message_start', 'content_block_start', 'content_block_delta', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop']);
  assert.match(text, /"text_delta","text":"Hello"/);
  assert.match(text, /"stop_reason":"end_turn"/);
});

test('401 → auth 分类，不重试，state=needs_login 进 snapshot', async (t) => {
  const stub = await startStub(t, (req, res) => {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ statusCodeValue: 401, body: 'invalid token' }));
  });
  const pool = makePool({ ...stub, t }, { maxAttempts: 3 });
  const { db, full } = seedDb({ name: 'dev', pools: ['qoder'] });
  const { base } = await startGateway(t, { pools: [pool], db });

  const res = await fetch(`${base}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': full },
    body: JSON.stringify({ model: 'qoder/Qwen3.7-Max', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] }),
  });
  const body = await res.json();

  assert.equal(res.status, 401);
  assert.equal(body.error.type, 'authentication_error');
  assert.equal(stub.requests.length, 1, 'auth 不可重试');
  assert.equal(pool.accounts[0].state, 'needs_login');
  assert.equal(pool.scheduler.snapshot()[0].state, 'needs_login');
});

test('quota：userQuota → ratio 进调度 quotaRatio；失败退避不再立即回源', async (t) => {
  let quotaHits = 0;
  const stub = await startStub(t, (req, res) => {
    if (req.url === '/quota') {
      quotaHits++;
      if (quotaHits === 1) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ userQuota: { used: 30, total: 100, remaining: 70, unit: 'credit' } }));
      } else {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end('{}');
      }
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(DOUBLE_SSE);
  });
  let fakeNow = 1_700_000_000_000;
  const quota = createQoderQuotaCache({ mode: 'global', url: `${stub.origin}/quota`, now: () => fakeNow });
  const pool = makePool({ ...stub, t }, { config: { quota } });

  const acc = pool.accounts[0];
  const first = await quota.get(acc);
  assert.equal(first.ratio, 0.7);
  assert.equal(pool.scheduler.snapshot()[0].quotaRatio, 0.7);

  fakeNow += 6 * 60_000; // 越过 5min TTL 后再查：失败 → 保留旧值标 stale
  const second = await quota.get(acc);
  assert.equal(second.source, 'stale', 'TTL 后回源失败 → 保留旧值标 stale');
  assert.equal(quotaHits, 2);
  fakeNow += 10_000; // 仍在退避窗口内
  const third = await quota.get(acc);
  assert.equal(third.source, 'stale');
  assert.equal(quotaHits, 2, '退避窗口内不回源');
});

test('PAT 交换：expires_in 按秒×1000；5min buffer；refresh 并发 10 次只 1 个请求', async (t) => {
  const now = 1_700_000_000_000;
  let exchangeHits = 0;
  const stub = await startStub(t, async (req, res) => {
    exchangeHits++;
    await new Promise((r) => setTimeout(r, 20));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ token: `jt-${exchangeHits}`, refresh_token: 'jr', expires_in: 86_400 }));
  });

  const creds = await credentialsFromPat('pt-x', 'global', {
    machineID: 'mach-1',
    fetchImpl: (url, opts) => fetch(`${stub.origin}/auth`, opts),
    now: () => now,
  });
  assert.equal(creds.jobToken, 'jt-1');
  assert.equal(creds.userID, '', 'userinfo 404 时回空（stub 没实现）');
  assert.equal(creds.expiresAt, now + 86_400_000 - 5 * 60_000, 'expires_in 秒→毫秒，且扣 5min buffer');

  const tokens = createTokenManager({ mode: 'global', url: `${stub.origin}/auth`, now: () => now });
  const acc = { id: 'x', pat: 'pt-x', jobToken: '', jobRefreshToken: '', jobTokenExpiresAt: 0, machineID: 'mach-1' };
  const baseline = stub.requests.length;
  const results = await Promise.all(Array.from({ length: 10 }, () => tokens.accessFor(acc)));
  // refresh 只补 exchange + userinfo 各 1 次；exchange 无 Authorization 头
  const delta = stub.requests.slice(baseline);
  assert.equal(delta.filter((r) => !r.headers.authorization).length, 1, '并发 10 次只 1 次交换在飞');
  assert.equal(delta.filter((r) => r.headers.authorization).length, 1);
  assert.ok(results.every((r) => typeof r.token === 'string' && r.token.startsWith('jt-')), `所有并发调用拿到同一个 token：${results.map((r) => r.token).join(',')}`);
  assert.equal(new Set(results.map((r) => r.token)).size, 1);
});

test('region：两池出现在 /v1/models 与 /health；域名配置正确', async (t) => {
  const stub = await startStub(t, (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(DOUBLE_SSE);
  });
  const globalPool = makePool({ ...stub, t }, { region: 'global' });
  const cnPool = makePool({ ...stub, t }, { region: 'cn' });
  const { base } = await startGateway(t, { pools: [globalPool, cnPool] });

  const health = await (await fetch(`${base}/health`)).json();
  assert.deepEqual(health.pools, ['qoder', 'qoder-cn']);
  const models = await (await fetch(`${base}/v1/models`)).json();
  const ids = models.data.map((m) => m.id);
  assert.ok(ids.some((id) => id.startsWith('qoder/')), ids.join(','));
  assert.ok(ids.some((id) => id.startsWith('qoder-cn/')));

  assert.match(chatUrl('global'), /^https:\/\/api3\.qoder\.sh\//);
  assert.match(chatUrl('cn'), /^https:\/\/gateway\.qoder\.com\.cn\//);
});

test('sendCollect：与 zcode 池同契约，不写 res', async (t) => {
  const stub = await startStub(t, (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(DOUBLE_SSE);
  });
  const pool = makePool({ ...stub, t });
  const res = {};
  let wrote = false;
  const guarded = new Proxy(res, {
    get(target, prop) {
      if (prop === 'writeHead' || prop === 'write' || prop === 'end') {
        return (...args) => {
          wrote = true;
          throw new Error(`sendCollect 不应写 res（${String(prop)}）`);
        };
      }
      return target[prop];
    },
  });

  const out = await pool.sendCollect({
    req: { headers: {} },
    res: guarded,
    body: { model: 'Qwen3.7-Max', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] },
  });

  assert.equal(wrote, false);
  assert.deepEqual({ status: out.status, contentType: out.contentType }, { status: 200, contentType: 'application/json' });
  const message = JSON.parse(out.bodyText);
  assert.deepEqual(message.content, [{ type: 'text', text: 'Hello world' }]);
});

test('envelope 业务错误（HTTP 200 信封 429）→ rate_limit 分类并换号重试', async (t) => {
  let hits = 0;
  const stub = await startStub(t, (req, res) => {
    hits++;
    if (hits === 1) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(`data: ${JSON.stringify({ statusCodeValue: 429, body: 'limited' })}\n\n`);
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(DOUBLE_SSE);
  });
  const pool = makePool({ ...stub, t }, {
    accounts: [ACCOUNT(), { ...ACCOUNT(), id: 'q-02', userID: 'u-2', jobToken: 'job-2' }],
    maxAttempts: 3,
  });

  const out = await pool.sendCollect({
    req: { headers: {} },
    res: {},
    body: { model: 'Qwen3.7-Max', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] },
  });
  assert.equal(JSON.parse(out.bodyText).content[0].text, 'Hello world');
  assert.equal(hits, 2, '第一个账号 429 → 换第二个账号');
  assert.ok(
    pool.accounts.filter((a) => a.id === 'q-01').some((a) => a.cooldownKind === 'rate_limit') ||
      pool.accounts.some((a) => a.cooldownKind === 'rate_limit'),
    '选中的第一个账号应被标 rate_limit 冷却',
  );
  assert.equal(pool.accounts.filter((a) => a.cooldownKind === 'rate_limit').length, 1);
});

test('F1（评审）：生产路径（不给 url 覆盖）refreshModels 成功，Cosy-Sigpath 正确', async (t) => {
  const stub = await startStub(t, (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ chat: [{ key: 'k1', enable: true, display_name: 'Test Model', is_reasoning: false }] }));
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ugw-qf1-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const pool = createQoderPool({
    accounts: [ACCOUNT()],
    region: 'global',
    // fetchImpl 包装：真实 model/list URL 重定向到桩（模拟生产域名），但不给 endpoints.modelList
    fetchImpl: (reqUrl, opts) => fetch(`${stub.origin}${new URL(reqUrl).pathname}${new URL(reqUrl).search}`, opts),
    config: { modelsCacheFile: path.join(dir, 'models-cache.json') },
  });

  assert.equal(pool.catalog.isStale(), true);
  const ok = await pool.refreshModels();
  assert.equal(ok, true, 'refresh 不应再被 computeSigPath(undefined) 打断');
  assert.equal(pool.catalog.isStale(), false);
  assert.equal(pool.models()[0].id, 'TestModel');
  assert.equal(pool.models()[0].degraded, false);
  const rec = stub.requests[0];
  assert.equal(rec.headers['cosy-sigpath'], '/api/v2/model/list', 'computeSigPath 剥掉 /algo 前缀（协议如此）');
  assert.match(rec.url, /^\/algo\/api\/v2\/model\/list/);
});

test('F2（评审）：quota 感知调度通电——请求后 peek 生效，不同 ratio 拉开权重；缓存期内不重复回源', async (t) => {
  let quotaHits = 0;
  const stub = await startStub(t, (req, res) => {
    if (req.url === '/quota') {
      quotaHits++;
      const remaining = req.headers.authorization === 'Bearer job-1' ? 90 : 10;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ userQuota: { used: 100 - remaining, total: 100, remaining, unit: 'credit' } }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(DOUBLE_SSE);
  });
  const quota = createQoderQuotaCache({ mode: 'global', url: `${stub.origin}/quota` });
  const pool = makePool({ ...stub, t }, {
    accounts: [ACCOUNT(), { ...ACCOUNT(), id: 'q-02', userID: 'u-2', jobToken: 'job-2' }],
    config: { quota },
  });

  // 先各刷一次额度（模拟 dispatch 的 fire-and-forget 到达后）
  await Promise.all([quota.get(pool.accounts[0]), quota.get(pool.accounts[1])]);
  await new Promise((r) => setTimeout(r, 10));

  assert.equal(quota.peek(pool.accounts[0]), 0.9);
  assert.equal(quota.peek(pool.accounts[1]), 0.1);
  const w1 = pool.scheduler.weightOf(pool.accounts[0]);
  const w2 = pool.scheduler.weightOf(pool.accounts[1]);
  assert.ok(w1 > w2, `额度高的账号权重应更高：w1=${w1} w2=${w2}`);

  // dispatch 路径通电：一次请求后（fire-and-forget）被选账号的 peek 仍有值
  await pool.sendCollect({
    req: { headers: {} },
    res: {},
    body: { model: 'Qwen3.7-Max', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] },
  });
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(
    pool.accounts.some((a) => quota.peek(a) !== null),
    'dispatch 内 fire-and-forget 生效：被选账号的 peek 在请求后非 null',
  );

  const after = quotaHits;
  await Promise.all([quota.get(pool.accounts[0]), quota.get(pool.accounts[1])]);
  assert.equal(quotaHits, after, '缓存期内不重复回源（5min TTL）');
});

test('F4（评审）：credentialsFromPat 兜底 region 的 name/email fallback', async (t) => {
  const stub = await startStub(t, (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ token: 'jt', refresh_token: 'jr', expires_in: 3600 }));
  });
  const creds = await credentialsFromPat('pt-x', 'cn', {
    fetchImpl: (url, opts) => fetch(`${stub.origin}/auth`, opts),
    now: () => 1_700_000_000_000,
  });
  assert.equal(creds.name, 'Qoder CN User');
  assert.equal(creds.email, 'user@qoder.com.cn');
});

test('F2（终审）：token 过期只刷新一次——patch（含 jobTokenExpiresAt）回写后不再重走交换', async (t) => {
  let exchangeCount = 0;
  const stub = await startStub(t, (req, res) => {
    if (req.url === '/auth') {
      if (req.headers.authorization) {
        // userinfo：回一个带 id 的假响应
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: 'u-x', email: 'x@qoder.com', name: 'X' }));
        return;
      }
      exchangeCount++;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ token: `jt-${exchangeCount}`, refresh_token: 'jr', expires_in: 3_600 }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(DOUBLE_SSE);
  });
  const pool = makePool({ ...stub, t }, {
    accounts: [{ ...ACCOUNT(), jobToken: '', jobTokenExpiresAt: 0 }], // 过期 → 必须先交换
    maxAttempts: 2,
  });

  await pool.sendCollect({
    req: { headers: {} },
    res: {},
    body: { model: 'Qwen3.7-Max', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] },
  });
  assert.equal(exchangeCount, 1, '第一次请求：过期 → 走 exchange');
  assert.ok(pool.accounts[0].jobTokenExpiresAt > Date.now(), 'patch 回写后过期时间是未来值');

  await pool.sendCollect({
    req: { headers: {} },
    res: {},
    body: { model: 'Qwen3.7-Max', max_tokens: 16, messages: [{ role: 'user', content: 'hi again' }] },
  });
  assert.equal(exchangeCount, 1, '第二次请求：token 已新 → 不再触发 exchange');
  assert.equal(pool.accounts[0].jobToken, 'jt-1');
});

test('classifyUpstreamError / anthropicMessageFromEvents 纯函数形状', () => {
  assert.deepEqual(classifyUpstreamError(401, ''), { kind: 'auth', code: 401, retryable: false, message: 'Qoder 凭证失效，需要重新登录' });
  assert.equal(classifyUpstreamError(429, '').kind, 'rate_limit');
  assert.equal(classifyUpstreamError(503, '').kind, 'server');
  assert.equal(classifyUpstreamError(400, '').kind, 'client');
  const env = classifyUpstreamError(200, JSON.stringify({ statusCodeValue: 429, body: 'x' }));
  assert.equal(env.kind, 'rate_limit');

  const message = anthropicMessageFromEvents([
    { type: 'message_start', message: { id: 'm1', type: 'message', role: 'assistant', model: 'x', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 't1', name: 'f', input: {} } },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"a":1}' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { input_tokens: 5, output_tokens: 2 } },
    { type: 'message_stop' },
  ]);
  assert.deepEqual(message.content, [{ type: 'tool_use', id: 't1', name: 'f', input: { a: 1 } }]);
  assert.equal(message.stop_reason, 'tool_use');
  assert.deepEqual(message.usage, { input_tokens: 5, output_tokens: 2 });
});
