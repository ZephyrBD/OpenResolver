import test from 'node:test';
import assert from 'node:assert/strict';
import { startGateway } from './helpers/gateway.mjs';
import { startStub } from './helpers/stub.mjs';
import { createZcodePool } from '../pools/zcode/index.mjs';

const PROFILE = { system: [{ type: 'text', text: 'S' }], max_tokens: 1000 };
const ACCOUNT = { id: 'z1', label: 'a1', jwt: 'jwt-1', uid: 'uid-1' };
const ASK = { model: 'zcode/GLM-5.3', messages: [{ role: 'user', content: 'hi' }] };

function pool(stub, config = {}) {
  return createZcodePool({
    accounts: [{ ...ACCOUNT }],
    profile: PROFILE,
    config: { origin: stub.origin, appVersion: '3.16.3', maxAttempts: 1, ...config },
  });
}

async function waitFor(fn, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return false;
}

test('a client disconnect aborts the upstream request', async (t) => {
  const stub = await startStub(t, () => {
    // 故意不响应，等着被 abort
  });
  const { base } = await startGateway(t, { pools: [pool(stub)] });

  const controller = new AbortController();
  const pending = fetch(`${base}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(ASK),
    signal: controller.signal,
  }).catch((err) => err);

  assert.equal(await waitFor(() => stub.requests.length === 1), true, '上游应收到请求');
  controller.abort();
  await pending;

  assert.equal(await waitFor(() => stub.requests[0].aborted), true, '客户端断开后上游连接必须关闭');
});

test('an upstream that never answers times out with 504', async (t) => {
  const stub = await startStub(t, () => {
    // 永不响应
  });
  const { base } = await startGateway(t, { pools: [pool(stub, { upstreamTimeoutMs: 150 })] });

  const res = await fetch(`${base}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(ASK),
  });

  assert.equal(res.status, 504);
  assert.equal(await waitFor(() => stub.requests[0].aborted), true);
});
