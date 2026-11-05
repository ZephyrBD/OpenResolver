import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startStub } from './helpers/stub.mjs';
import { seedDb } from './helpers/gateway.mjs';
import { createGateway } from '../gateway.mjs';
import { createUsageRecorder, usageDate } from '../panel/usage.mjs';
import { tmpDataDir, startPanel, login, panelFetch } from './helpers/panel.mjs';

const DAY = 24 * 3_600_000;
let t0 = 1_700_000_000_000;
const now = () => t0;

const USAGE = { input_tokens: 12, output_tokens: 34, cache_read_input_tokens: 5 };

function usagePool(name = 'zcode') {
  return {
    name,
    type: 'pool',
    models: () => [{ id: 'GLM' }],
    send({ res, body }) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'message', role: 'assistant', usage: USAGE }));
    },
  };
}

function ssePool() {
  return {
    name: 'zcode',
    type: 'pool',
    models: () => [{ id: 'GLM' }],
    send({ res }) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":9}}}\n\n');
      res.write('event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"嗨"}}\n\n');
      res.write('event: message_stop\ndata: {"type":"message_stop"}\n\n');
      res.end();
    },
  };
}

async function startUsageGateway(t, { pool, dataDir, config = {} } = {}) {
  const { db, full } = seedDb({ name: 'u' });
  const usage = createUsageRecorder({ dataDir, maxFileBytes: config.maxUsageFileBytes, now });
  const server = createGateway({ config: { version: '0.1.0', ...config }, pools: [pool], db, usage });
  const port = await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
  t.after(() => new Promise((r) => server.close(r)));
  return { base: `http://127.0.0.1:${port}`, secret: full, usage };
}

function post(base, secret, body) {
  return fetch(`${base}/v1/messages`, {
    method: 'POST',
    headers: { 'x-api-key': secret, 'content-type': 'application/json', 'anthropic-version': '2023-06-01' },
    body: JSON.stringify(body),
  });
}

test('panel.usage: 非流式 /v1/messages 成功 → jsonl 一行、token 数正确', async (t) => {
  const dataDir = tmpDataDir(t);
  const { base, secret } = await startUsageGateway(t, { pool: usagePool(), dataDir, config: { dataDir } });

  const res = await post(base, secret, { model: 'zcode/GLM', messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(res.status, 200);
  await res.text();
  await new Promise((r) => setTimeout(r, 50)); // appendFile 异步

  const file = path.join(dataDir, 'usage', `${usageDate(now())}.jsonl`);
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  assert.equal(lines.length, 1);
  const entry = JSON.parse(lines[0]);
  assert.deepEqual(
    {
      pool: entry.pool,
      model: entry.model,
      keyId: typeof entry.keyId,
      status: entry.status,
      inputTokens: entry.inputTokens,
      outputTokens: entry.outputTokens,
      cacheReadTokens: entry.cacheReadTokens,
    },
    { pool: 'zcode', model: 'GLM', keyId: 'string', status: 200, inputTokens: 12, outputTokens: 34, cacheReadTokens: 5 },
  );
  assert.equal(typeof entry.ts, 'number');
  assert.equal(typeof entry.durationMs, 'number');
});

test('panel.usage: 流式记录不破坏 SSE（token 填 0）', async (t) => {
  const dataDir = tmpDataDir(t);
  const { base, secret } = await startUsageGateway(t, { pool: ssePool(), dataDir, config: { dataDir } });

  const res = await post(base, secret, {
    model: 'zcode/GLM',
    stream: true,
    messages: [{ role: 'user', content: 'hi' }],
  });
  assert.equal(res.headers.get('content-type'), 'text/event-stream');
  const text = await res.text();
  assert.equal(text.split('\n\n').filter(Boolean).length, 3, 'SSE 事件完整');
  await new Promise((r) => setTimeout(r, 50));

  const file = path.join(dataDir, 'usage', `${usageDate(now())}.jsonl`);
  const entry = JSON.parse(fs.readFileSync(file, 'utf8').trim());
  assert.equal(entry.status, 200);
  assert.equal(entry.inputTokens, 0);
  assert.equal(entry.outputTokens, 0);
});

test('panel.usage: 按天分片文件名', async (t) => {
  const dataDir = tmpDataDir(t);
  const { base, secret, usage } = await startUsageGateway(t, { pool: usagePool(), dataDir, config: { dataDir } });

  await post(base, secret, { model: 'zcode/GLM', messages: [{ role: 'user', content: 'day1' }] });
  t0 += DAY;
  await post(base, secret, { model: 'zcode/GLM', messages: [{ role: 'user', content: 'day2' }] });
  await new Promise((r) => setTimeout(r, 50));

  const dir = path.join(dataDir, 'usage');
  assert.deepEqual(fs.readdirSync(dir).sort(), [`${usageDate(t0 - DAY)}.jsonl`, `${usageDate(t0)}.jsonl`].sort());

  // series 聚合按天
  const series = usage.series(2);
  assert.equal(series.length, 2);
  assert.equal(series[1].requests, 1);
  assert.equal(series[0].requests, 1);
  assert.equal(series[1].inputTokens, 12);
});

test('panel.usage: 超限停写（注入小上限）', async (t) => {
  const dataDir = tmpDataDir(t);
  // 上限 100 字节：第一行就超，之后停写
  const { base, secret, usage } = await startUsageGateway(t, {
    pool: usagePool(),
    dataDir,
    config: { dataDir, maxUsageFileBytes: 100 },
  });

  await post(base, secret, { model: 'zcode/GLM', messages: [{ role: 'user', content: 'a' }] });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(usage.degraded, true); // 文件已 > 100 字节

  await post(base, secret, { model: 'zcode/GLM', messages: [{ role: 'user', content: 'b' }] });
  await post(base, secret, { model: 'zcode/GLM', messages: [{ role: 'user', content: 'c' }] });
  await new Promise((r) => setTimeout(r, 50));

  const file = path.join(dataDir, 'usage', `${usageDate(now())}.jsonl`);
  assert.equal(fs.readFileSync(file, 'utf8').trim().split('\n').length, 1, '超限后停写');
});

test('panel.usage: overview 接口带 usageDegraded 与 today 聚合', async (t) => {
  const dataDir = tmpDataDir(t);
  const usage = createUsageRecorder({ dataDir, now });
  const panel = await startPanel(t, { dataDir, now, usage });
  usage.record({ pool: 'zcode', model: 'GLM', status: 200, inputTokens: 100, outputTokens: 20 });
  usage.record({ pool: 'zcode', model: 'GLM', status: 500, inputTokens: 0, outputTokens: 0 });
  await new Promise((r) => setTimeout(r, 50));

  const { cookies } = await login(panel.base);
  const body = await (await panelFetch(panel.base, '/api/overview', { cookies })).json();
  assert.deepEqual(body.today, { requests: 2, errors: 1, inputTokens: 100, outputTokens: 20 });
  assert.equal(body.usageDegraded, false);
});

test('panel.usage: 写入失败不影响推理响应状态', async (t) => {
  const dataDir = tmpDataDir(t);
  // usage 目录位置被一个同名文件占住 → append 必失败
  fs.writeFileSync(path.join(dataDir, 'usage'), 'not a dir', { mode: 0o600 });
  const { base, secret, usage } = await startUsageGateway(t, { pool: usagePool(), dataDir, config: { dataDir } });

  const res = await post(base, secret, { model: 'zcode/GLM', messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.type, 'message');
  assert.equal(usage.today().requests, 0);
});
