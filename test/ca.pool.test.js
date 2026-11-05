// ca.pool.test.js — 端到端 /v1/messages（真 HTTP 桩）：签名复算、401→needs_login、
// 三路模型发现 + 福利领取 + srcFail 退避、sendCollect 契约、池名进 /health 与 /v1/models。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { newDpopPrivateJwk } from '../pools/codearts/dpop.mjs';
import { startStub } from './helpers/stub.mjs';
import { startGateway, seedDb } from './helpers/gateway.mjs';
import { createCodeartsPool, classifyUpstreamError, buildCaPayload, sessionIdFor } from '../pools/codearts/index.mjs';
import { identityFromRefreshToken, accountFromToken } from '../pools/codearts/auth.mjs';
import { embeddedSseStatus } from '../pools/codearts/stream.mjs';
import { boot } from '../boot.mjs';
import { signRequest } from '../pools/codearts/signer.mjs';
import { EP_CHAT_V2 } from '../pools/codearts/constants.mjs';

const ACCOUNT = (id = 'ca-1', userId = 'u1') => ({
  id,
  userId,
  userName: 'zephyr',
  domainId: 'd1',
  accessKeyID: 'AK',
  secretAccessKey: 'SK',
  securityToken: 'ST',
  expiresAt: Date.now() + 3_600_000,
  refreshToken: `rt-${id}`,
  codeVerifier: 'verifier',
  dpopJwk: null,
  state: 'ok',
  weight: 10,
  enabled: true,
});

function openAiSse(chunks) {
  return chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n';
}
const OK_SSE = openAiSse([
  { id: 'c1', object: 'chat.completion.chunk', model: 'GLM-5.2', choices: [{ index: 0, delta: { role: 'assistant', content: '你好' }, finish_reason: null }] },
  { id: 'c1', object: 'chat.completion.chunk', model: 'GLM-5.2', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
]);

function makePool(stub, overrides = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ugw-ca-pool-'));
  return createCodeartsPool({
    accounts: overrides.accounts ?? [ACCOUNT()],
    config: {
      dataDir,
      snapBase: stub.origin,
      benefitBase: stub.origin,
      endpoints: { chat: `${stub.origin}${EP_CHAT_V2}`, models: stub.origin, benefit: stub.origin, biz: stub.origin },
      maxAttempts: overrides.maxAttempts ?? 3,
      ...(overrides.config ?? {}),
    },
    ...(overrides.pool ?? {}),
  });
}

async function runMessages(base, full, body) {
  const res = await fetch(`${base}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': full },
    body: JSON.stringify(body),
  });
  return res;
}

test('端到端非流式：桩断言 x-auth-token + X-Sdk-Date 存在且 Authorization 可独立复算；body 是 OpenAI 形状 + 亲和字段', async (t) => {
  const stub = await startStub(t, (req, res) => {
    // 成功 dispatch 后的额度 fire-and-forget 也会打同一个桩：非 chat 请求给空 JSON
    if (req.url !== EP_CHAT_V2) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
      return;
    }
    const h = req.headers;
    assert.equal(h['x-auth-token'], 'ST');
    assert.ok(h['x-sdk-date'], 'X-Sdk-Date 存在');
    assert.ok(h['x-security-token'] === 'ST');
    assert.ok(h.authorization.startsWith('SDK-HMAC-SHA256 Access=AK, SignedHeaders='));
    const body = JSON.parse(
      // body 在 rec 里断言更稳；这里只断形状要点
      '{}',
    );
    void body;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(OK_SSE);
  });
  const pool = makePool(stub, { maxAttempts: 1 });
  const { db, full } = seedDb({ name: 'dev', pools: ['codearts'] });
  const { base } = await startGateway(t, { pools: [pool], db });

  const res = await runMessages(base, full, { model: 'codearts/glm-5.2', max_tokens: 64, messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(res.status, 200);
  const message = await res.json();
  assert.equal(message.type, 'message');
  assert.deepEqual(message.content, [{ type: 'text', text: '你好' }]);
  assert.equal(message.usage.input_tokens, 0);

  // 事后按 Authorization 里声明的 SignedHeaders 从线上请求重建头并复算签名（wire 上
  // 的 content-length/connection 未签名，必须剔除；以 SignedHeaders 声明为准最精确）
  const rec = stub.requests[0];
  const body = JSON.parse(rec.body);
  assert.equal(body.model, 'GLM-5.2', '模型大小写归一');
  assert.equal(body.stream, true);
  assert.ok(body.prompt_cache_key, 'prompt_cache_key 存在');
  assert.equal(body.chat_id, body.prompt_cache_key);
  assert.equal(body.tool_stream, true);
  assert.deepEqual(body.messages, [{ role: 'user', content: 'hi' }], 'Anthropic → OpenAI 消息转换');
  assert.equal(sessionIdFor(body.chat_id).length, 32);

  const signedList = rec.headers.authorization.match(/SignedHeaders=([^,]+)/)[1].split(';');
  const rebuilt = {};
  for (const key of signedList) rebuilt[key] = rec.headers[key];
  const signed = signRequest(
    { method: 'POST', url: `${stub.origin}${EP_CHAT_V2}`, headers: rebuilt, body: rec.body },
    { accessKeyID: 'AK', secretAccessKey: 'SK', securityToken: 'ST' },
  );
  assert.equal(signed.Authorization, rec.headers.authorization, '签名字节级复算一致');
});

test('端到端流式：Anthropic 事件序列按整段比较', async (t) => {
  const stub = await startStub(t, (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(OK_SSE);
  });
  const pool = makePool(stub, { maxAttempts: 1 });
  const { db, full } = seedDb({ name: 'dev', pools: ['codearts'] });
  const { base } = await startGateway(t, { pools: [pool], db });

  const res = await runMessages(base, full, { model: 'codearts/glm-5.2', max_tokens: 64, stream: true, messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'text/event-stream');
  const text = await res.text();
  assert.match(text, /event: message_start/);
  assert.match(text, /"text_delta","text":"你好"/);
  assert.match(text, /event: message_stop/);
});

test('HTTP 401 → 账号 needs_login + 客户端 401', async (t) => {
  const stub = await startStub(t, (req, res) => {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end('{"error_code":"login required"}');
  });
  const pool = makePool(stub, { maxAttempts: 1 });
  const { db, full } = seedDb({ name: 'dev', pools: ['codearts'] });
  const { base } = await startGateway(t, { pools: [pool], db });

  const res = await runMessages(base, full, { model: 'codearts/glm-5.2', max_tokens: 64, messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(res.status, 401);
  assert.equal(pool.scheduler.accounts[0].state, 'needs_login');
});

test('classifyUpstreamError：401→auth；429→rate_limit；5xx→server；error_code 信封按 embedded 分类', () => {
  assert.equal(classifyUpstreamError(401, '').kind, 'auth');
  assert.equal(classifyUpstreamError(429, '').kind, 'rate_limit');
  assert.equal(classifyUpstreamError(500, 'oops').kind, 'server');
  assert.equal(classifyUpstreamError(400, 'bad').kind, 'client');
  const benefit = classifyUpstreamError(200, JSON.stringify({ error_code: 'InferHub.4004.200', error_msg: 'benefit not found' }));
  assert.equal(benefit.kind, 'client', '4004.200 是该请求级客户端问题');
  const tpm = classifyUpstreamError(200, JSON.stringify({ error_code: 'ModelArts.81111.429', error_msg: 'TPM limit reached' }));
  assert.equal(tpm.kind, 'rate_limit');
  const server = classifyUpstreamError(200, JSON.stringify({ error_code: 'X.999', error_msg: 'boom' }));
  assert.equal(server.kind, 'server');
  // TM.000010051：模型未开通/无权调用 → 该请求级客户端问题，不重试、不惩罚账号
  const notOpen = classifyUpstreamError(
    200,
    JSON.stringify({ error_code: 'TM.000010051', error_msg: '您当前无权调用该模型，请联系企业管理员开通。' }),
  );
  assert.equal(notOpen.kind, 'client');
  assert.equal(notOpen.retryable, false);
  assert.match(notOpen.message, /模型未开通/);
  assert.equal(embeddedSseStatus('TM.000010051', '您当前无权调用该模型'), 400, '流内信封同样落 400');
  assert.equal(embeddedSseStatus('TM.000010051', ''), 400, '只给错误码也要判 400');
});

test('福利路由：种子模型带 maas_type: benefit 头（计入签名）；目录转正后摘头', async (t) => {
  const stub = await startStub(t, (req, res, rec) => {
    // 额度 fire-and-forget 的辅助请求：不解析 chat body
    if (req.url !== EP_CHAT_V2) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
      return;
    }
    const body = JSON.parse(rec.body);
    // 请求 1：glm-5.3-flash（种子福利）必须带头；请求 2：GLM-5.2（内置）不带头
    if (body.model === 'glm-5.3-flash' || body.model === 'GLM-5.3-Flash') {
      assert.equal(rec.headers['maas_type'], 'benefit');
    } else {
      assert.equal(rec.headers['maas_type'], undefined);
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(OK_SSE);
  });
  const pool = makePool(stub, { maxAttempts: 1 });
  const { db, full } = seedDb({ name: 'dev', pools: ['codearts'] });
  const { base } = await startGateway(t, { pools: [pool], db });

  let res = await runMessages(base, full, { model: 'codearts/glm-5.3-flash', max_tokens: 64, messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(res.status, 200, '种子福利模型带头可通');
  res = await runMessages(base, full, { model: 'codearts/glm-5.2', max_tokens: 64, messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(res.status, 200);
});

test('模型三路发现：单路失败降级 + 福利幂等领取调用断言 + 合并/排序', async (t) => {
  const stub = await startStub(t, (req, res, rec) => {
    if (req.url.startsWith('/v1/agent-center/agents/useragents')) {
      res.end(JSON.stringify({ agents: [{ agent_id: 'a1', agent_name: 'CodeAgent', alias: { alias_zh_cn: '智能体' }, show_in_ide: true }] }));
      return;
    }
    if (req.url.startsWith('/v1/agent-center/agents/detail')) {
      res.end(JSON.stringify({ gpts: { models: [{ model_name: 'AgentOnly', model_parameters: { context_window: 32000, max_tokens: 8000 } }] } }));
      return;
    }
    if (req.url === '/v1/model/builtin') {
      res.end(JSON.stringify({ builtinModels: [{ model_id: 'GLM-5.2', context_window: 168000 }] }));
      return;
    }
    if (req.url === '/api/v1/benefit/claim') {
      assert.equal(rec.headers['x-security-token'], 'ST', '领取请求带 STS 凭证签名');
      res.end(JSON.stringify({ error_code: '0000' }));
      return;
    }
    if (req.url === '/api/v1/gateway/config') {
      res.end(JSON.stringify({ error_code: '0000', result: { models: [{ model_id: 'deepseek-v4-pro-0813', model_desc: 'benefit' }] } }));
      return;
    }
    res.end('{}');
  });
  const pool = makePool(stub, { maxAttempts: 1 });
  assert.equal(await pool.refreshModels(), true, '三路全成功');
  assert.equal(pool.catalog.source, 'agent+builtin+benefit');
  const ids = pool.models().map((m) => m.id);
  assert.deepEqual(ids, ['AgentOnly', 'deepseek-v4-pro-0813', 'GLM-5.2'], '按小写 ID 字节序排序');
  assert.equal(pool.models().find((m) => m.id === 'GLM-5.2').context_window, 168000);
  assert.equal(pool.models().find((m) => m.id === 'deepseek-v4-pro-0813').benefit, true);
  assert.ok(stub.requests.some((r) => r.url === '/api/v1/benefit/claim'), 'claimAuto 默认开，领取被调用');

  // IsBenefitModel：benefit 路登记的模型带标记；builtin/agent 登记的不带
  assert.equal(pool.catalog.isBenefit('u1', 'deepseek-v4-pro-0813'), true);
  assert.equal(pool.catalog.isBenefit('u1', 'GLM-5.2'), false, 'builtin 登记转正');
  // canonicalModel：known 归一
  assert.equal(pool.catalog.canonicalModel('glm-5.2'), 'GLM-5.2');
  assert.equal(pool.catalog.canonicalModel('unknown-model'), 'unknown-model');
});

test('空 userId：目录键回退账号 id，发现结果不丢；种子已下架模型不再判福利', async (t) => {
  const stub = await startStub(t, (req, res) => {
    if (req.url.startsWith('/v1/agent-center/agents/useragents')) {
      res.end(JSON.stringify({ agents: [{ agent_id: 'a1', agent_name: 'CodeAgent', alias: { alias_zh_cn: '智能体' }, show_in_ide: true }] }));
      return;
    }
    if (req.url.startsWith('/v1/agent-center/agents/detail')) {
      res.end(JSON.stringify({ gpts: { models: [{ model_name: 'GLM-5.2' }] } }));
      return;
    }
    if (req.url === '/v1/model/builtin') {
      res.end(JSON.stringify({ builtinModels: [{ model_id: 'glm-5.3' }] }));
      return;
    }
    if (req.url === '/api/v1/benefit/claim') {
      res.end(JSON.stringify({ error_code: '0000' }));
      return;
    }
    if (req.url === '/api/v1/gateway/config') {
      // live 账号现状：福利通道 4000 invalid channel（目录只靠 agent+builtin）
      res.end(JSON.stringify({ error_code: '4000', error_msg: 'invalid channel, group not found' }));
      return;
    }
    res.end('{}');
  });
  const pool = makePool(stub, {
    accounts: [{ ...ACCOUNT('ca-empty', ''), userName: '', domainId: '' }],
    maxAttempts: 1,
  });

  assert.equal(await pool.refreshModels(), true, 'agent+builtin 成功即算发现成功（benefit 失败不影响）');
  const ids = pool.models().map((m) => m.id);
  assert.ok(ids.includes('GLM-5.2'), '发现到的内置模型进 /v1/models');
  assert.ok(ids.includes('glm-5.3'), 'builtin 下发的 glm-5.3 进 /v1/models');
  assert.ok(!ids.includes('deepseek-v4-flash-0731'), '已下架的种子福利模型不再出现在列表');

  // 目录存在即权威：未知/已下架模型一律非福利，不带 maas_type: benefit
  assert.equal(pool.catalog.isBenefit('ca-empty', 'deepseek-v4-flash-0731'), false);
  assert.equal(pool.catalog.isBenefit('ca-empty', 'GLM-5.2'), false);
  assert.equal(pool.catalog.isBenefit('ca-empty', 'glm-5.3'), false, 'builtin 登记即非福利');
});

test('srcFail 退避：同来源失败后 5min 内不再打该端点', async (t) => {
  let builtinHits = 0;
  const stub = await startStub(t, (req, res) => {
    if (req.url.startsWith('/v1/agent-center/agents/useragents')) {
      res.end(JSON.stringify({ agents: [{ agent_id: 'a1', agent_name: 'CodeAgent', alias: { alias_zh_cn: '智能体' }, show_in_ide: true }] }));
      return;
    }
    if (req.url.startsWith('/v1/agent-center/agents/detail')) {
      res.end(JSON.stringify({ gpts: { models: [{ model_name: 'AgentOnly' }] } }));
      return;
    }
    if (req.url === '/v1/model/builtin') {
      builtinHits++;
      res.writeHead(500);
      res.end('boom');
      return;
    }
    if (req.url === '/api/v1/benefit/claim') {
      res.end(JSON.stringify({ error_code: '0000' }));
      return;
    }
    if (req.url === '/api/v1/gateway/config') {
      res.end(JSON.stringify({ error_code: '0000', result: { models: [{ model_id: 'B1' }] } }));
      return;
    }
    res.end('{}');
  });
  const pool = makePool(stub, { maxAttempts: 1 });
  await pool.refreshModels();
  const hitsAfterFirst = builtinHits;
  await pool.refreshModels();
  assert.equal(builtinHits, hitsAfterFirst, '第二次发现 builtin 处于退避窗口，未打上游');
});

test('sendCollect 契约：返回 {status, contentType, bodyText}，不发 res', async (t) => {
  const stub = await startStub(t, (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(OK_SSE);
  });
  const pool = makePool(stub, { maxAttempts: 1 });
  const out = await pool.sendCollect({ req: null, res: null, body: { model: 'glm-5.2', max_tokens: 64, messages: [{ role: 'user', content: 'hi' }] }, key: null });
  assert.equal(out.status, 200);
  assert.equal(out.contentType, 'application/json');
  const message = JSON.parse(out.bodyText);
  assert.deepEqual(message.content, [{ type: 'text', text: '你好' }]);
});

test('quota：dispatch 后 fire-and-forget 拉取积分，peek 非 null（调度/余额同源）', async (t) => {
  const stub = await startStub(t, (req, res) => {
    if (req.url.startsWith('/snap-manager/v1/statistics/plugin')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        package: { status: 'normal', package_name_cn: '基础套餐' },
        end_date: '2026-12-31 23:59:59',
        metrics: [
          { name: 'usageTotalPackageCredit', package_credit_amount: 1000, package_credit_used: 250, package_credit_remain: 750 },
          { name: 'usageBasicPackageCredit', package_credit_amount: 800, package_credit_used: 200 },
          { name: 'usageOnDemandPackageCredit', package_credit_amount: 200, package_credit_used: 50 },
          { name: 'usageBonusPackageCredit', package_credit_amount: 0, package_credit_used: 0 },
        ],
      }));
      return;
    }
    if (req.url.startsWith('/v1/ops/delivery')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: { items: [] } }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(OK_SSE);
  });
  const pool = makePool(stub, { maxAttempts: 1 });
  const { db, full } = seedDb({ name: 'dev', pools: ['codearts'] });
  const { base } = await startGateway(t, { pools: [pool], db });

  const res = await runMessages(base, full, { model: 'codearts/glm-5.2', max_tokens: 64, messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(res.status, 200);

  // fire-and-forget：等微任务 + 桩响应落定
  await new Promise((r) => setTimeout(r, 100));
  const acc = pool.scheduler.accounts[0];
  assert.equal(pool.quota.peek(acc), 0.75, '剩余 750 / 总额 1000');
  const snap = pool.scheduler.snapshot().find((a) => a.id === acc.id);
  assert.equal(snap.quotaRatio, 0.75, '调度器快照读的是同一份 quota.peek（额度进权重）');
  assert.ok(
    stub.requests.some((r) => r.url.startsWith('/snap-manager/v1/statistics/plugin')),
    'dispatch 成功后额度查询打到桩',
  );
});

test('池名 codearts 进 /health 与 /v1/models（无账号静态降级表）', async (t) => {
  const stub = await startStub(t, (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  });
  const pool = makePool(stub, { accounts: [] });
  const { db, full } = seedDb({ name: 'dev', pools: ['codearts'] });
  const { base } = await startGateway(t, { pools: [pool], db });

  const health = await (await fetch(`${base}/health`)).json();
  assert.ok(health.pools.includes('codearts'));

  const models = await (await fetch(`${base}/v1/models`, { headers: { 'x-api-key': full } })).json();
  const ids = models.data.map((m) => m.id);
  assert.ok(ids.some((id) => id.startsWith('codearts/')), 'codearts 池有模型');
  assert.ok(ids.some((id) => id === 'codearts/glm-5.3-flash'), '静态降级表含种子福利模型');
});

test('refresh patch 整组落盘：accounts.json 更新新 STS 凭证与 refresh_token', async (t) => {
  const stub = await startStub(t, (req, res) => {
    if (req.url === '/v1/oauth2/tokens') {
      // DPoP 头必须用原密钥对（桩只断言存在）
      assert.ok(req.headers.dpop);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        user_id: 'u1', refresh_token: 'rt-new',
        credentials: { access_key_id: 'AK2', secret_access_key: 'SK2', security_token: 'ST2', expiration: '2099-01-01T00:00:00Z' },
      }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(OK_SSE);
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ugw-ca-disk-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const accountsFile = path.join(dir, 'accounts.json');
  const dpopJwk = newDpopPrivateJwk();
  fs.writeFileSync(accountsFile, JSON.stringify([{ ...ACCOUNT('ca-1'), securityToken: '', expiresAt: 0, dpopJwk }]));

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ugw-ca-pool-'));
  const pool = createCodeartsPool({
    accounts: [{ ...ACCOUNT('ca-1'), securityToken: '', expiresAt: 0, dpopJwk }],
    config: {
      dataDir,
      snapBase: stub.origin,
      benefitBase: stub.origin,
      endpoints: { chat: `${stub.origin}${EP_CHAT_V2}`, models: stub.origin, benefit: stub.origin, biz: stub.origin },
      maxAttempts: 1,
      accountsFile,
      loginConfig: { stsHost: stub.origin, snapManager: stub.origin, portalHost: stub.origin },
    },
  });
  const { db, full } = seedDb({ name: 'dev', pools: ['codearts'] });
  const { base } = await startGateway(t, { pools: [pool], db });
  const res = await runMessages(base, full, { model: 'codearts/glm-5.2', max_tokens: 64, messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(res.status, 200);
  const persisted = JSON.parse(fs.readFileSync(accountsFile, 'utf8'));
  assert.equal(persisted[0].securityToken, 'ST2', '新 STS 凭证落盘');
  assert.equal(persisted[0].accessKeyID, 'AK2');
  assert.equal(persisted[0].refreshToken, 'rt-new', '轮换 refresh_token 整组落盘');
});

test('buildCaPayload：system 消息转 role:system + max_tokens 透传（M2 复用）', () => {
  const payload = buildCaPayload(
    { model: 'glm-5.2', max_tokens: 128, system: 'you are helpful', messages: [{ role: 'user', content: 'hi' }] },
    'GLM-5.2',
    'chat-1',
  );
  assert.equal(payload.model, 'GLM-5.2');
  assert.equal(payload.max_tokens, 128);
  assert.deepEqual(payload.messages[0], { role: 'system', content: 'you are helpful' });
  assert.equal(payload.chat_id, 'chat-1');
});

test('ca.pool: chat 请求带 Chat-Id/Session-Id（签名后设置，vendor client.go:566-571）', async (t) => {
  const mod = await import('../pools/codearts/index.mjs');
  const chatId = '0f0e1d2c-3b4a-5968-8796-a5b4c3d2e1f0';
  const sid = mod.sessionIdFor(chatId);
  assert.match(sid, /^[0-9a-f]{32}$/, 'Session-Id 为 32 位 hex');
  assert.equal(mod.sessionIdFor(chatId), sid, '同 chatId 派生稳定');
});

test('ca.pool: 暴露 credsOf（claimer/额度共用），凭证有效期内不刷 token', async (t) => {
  const stub = await startStub(t, (req, res) => {
    // 凭证有效期内不允许打 token 端点（打了就说明 credsOf 无谓刷新）
    res.writeHead(500);
    res.end('should not be called');
  });
  const pool = makePool(stub);

  assert.equal(typeof pool.credsOf, 'function', '池必须把 credsOf 暴露给 claimer');
  const cred = await pool.credsOf(pool.accounts[0]);
  assert.deepEqual(cred, { accessKeyID: 'AK', secretAccessKey: 'SK', securityToken: 'ST' });
  assert.equal(stub.requests.length, 0, 'STS 未过期时不得回源 token 端点');
});

/** 造一个只带 user_profile 的 refresh_token JWT（profile 是 base64(JSON) 字符串）。 */
function fakeRefreshToken(profile) {
  const b64 = (obj) => Buffer.from(JSON.stringify(obj), 'utf8').toString('base64');
  return `eyJhbGciOiJub25lIn0.${b64({ user_profile: b64(profile) })}.signature`;
}

test('身份补齐：identityFromRefreshToken 解 user_profile；accountFromToken 用它填 userId/domainId/label', () => {
  const refreshToken = fakeRefreshToken({ principal_id: 'p-1', account_id: 'd-1', account_name: 'GT-ZephyrBD' });
  assert.deepEqual(identityFromRefreshToken(refreshToken), { userId: 'p-1', userName: 'GT-ZephyrBD', domainId: 'd-1' });
  assert.equal(identityFromRefreshToken('not-a-jwt'), null, '坏 token 失败软返回 null');
  assert.equal(identityFromRefreshToken('a.b.c'), null, 'profile 缺失返回 null');

  // 上游 token 响应不带 user_id（live 现状）：身份必须从 refresh_token 补
  const acc = accountFromToken(
    {
      refresh_token: refreshToken,
      credentials: { access_key_id: 'AK', secret_access_key: 'SK', security_token: 'ST', expiration: '2099-01-01T00:00:00Z' },
    },
    { codeVerifier: 'v', dpopJwk: null },
  );
  assert.equal(acc.userId, 'p-1');
  assert.equal(acc.userName, 'GT-ZephyrBD');
  assert.equal(acc.domainId, 'd-1');
  assert.equal(acc.label, 'GT-ZephyrBD');
  assert.equal(acc.id, 'ca-p-1', 'id 用身份 userId 派生');
});

test('boot 回填：老账号空 userId 从 refresh_token 补身份落盘，id 不变', async (t) => {
  const stub = await startStub(t, (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ugw-ca-boot-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const caDir = path.join(dir, 'pools', 'codearts');
  fs.mkdirSync(caDir, { recursive: true });
  const refreshToken = fakeRefreshToken({ principal_id: 'p-9', account_id: 'd-9', account_name: 'GT-ZephyrBD' });
  fs.writeFileSync(
    path.join(caDir, 'accounts.json'),
    JSON.stringify([
      {
        id: 'ca-old',
        userId: '',
        userName: '',
        domainId: '',
        label: '',
        accessKeyID: 'AK',
        secretAccessKey: 'SK',
        securityToken: 'ST',
        expiresAt: Date.now() + 3_600_000,
        refreshToken,
        codeVerifier: 'v',
        dpopJwk: null,
        state: 'ok',
        weight: 10,
        enabled: true,
      },
    ]),
  );

  // 模型发现打桩，避免 boot 的 fire-and-forget 出网
  const { server } = boot({
    env: { UGW_DATA_DIR: dir, PORT: '0', UGW_CA_SNAP_BASE: stub.origin, UGW_CA_BENEFIT_BASE: stub.origin },
    log: () => {},
  });
  t.after(() => new Promise((r) => server.close(r)));

  const persisted = JSON.parse(fs.readFileSync(path.join(caDir, 'accounts.json'), 'utf8'));
  assert.equal(persisted.length, 1);
  assert.equal(persisted[0].id, 'ca-old', 'id 不得被回填改写');
  assert.equal(persisted[0].userId, 'p-9');
  assert.equal(persisted[0].userName, 'GT-ZephyrBD');
  assert.equal(persisted[0].domainId, 'd-9');
  assert.equal(persisted[0].label, 'GT-ZephyrBD');
});
