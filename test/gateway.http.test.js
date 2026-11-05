import test from 'node:test';
import assert from 'node:assert/strict';
import { startGateway, seedDb, zcodePool } from './helpers/gateway.mjs';

test('GET /v1/models prefixes every model with its pool', async (t) => {
  const { base } = await startGateway(t);

  const res = await fetch(`${base}/v1/models`);
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.equal(body.object, 'list');
  assert.deepEqual(
    body.data.map((m) => m.id),
    ['zcode/GLM-5.3', 'zcode/GLM-5.3-Flash'],
  );
  assert.deepEqual(body.data[0], {
    id: 'zcode/GLM-5.3',
    object: 'model',
    display_name: 'GLM-5.3 (ZCode)',
    upstream_model: 'GLM-5.3',
    pool: 'zcode',
    context_window: 128000,
    supports_tools: true,
    supports_thinking: true,
    created: 0,
  });
});

test('GET /v1/models rejects an invalid key', async (t) => {
  const { db } = seedDb({ name: 'dev' });
  const { base } = await startGateway(t, { db });

  const res = await fetch(`${base}/v1/models`, { headers: { 'x-api-key': 'zsk_bogus' } });
  const body = await res.json();

  assert.equal(res.status, 401);
  assert.equal(body.error.type, 'authentication_error');
});

test('GET /v1/models honours the pool allowlist', async (t) => {
  const { db, full } = seedDb({ name: 'dev', pools: ['trae'] });
  const { base } = await startGateway(t, { db });

  const res = await fetch(`${base}/v1/models`, { headers: { 'x-api-key': full } });

  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()).data, []);
});

test('POST /v1/messages rejects a model without a pool prefix', async (t) => {
  const { base } = await startGateway(t);

  const res = await fetch(`${base}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'GLM-5.3', messages: [] }),
  });
  const body = await res.json();

  assert.equal(res.status, 400);
  assert.equal(body.error.type, 'invalid_request_error');
});

test('POST /v1/messages rejects a body over the configured limit with 413', async (t) => {
  const db = { version: 1, keys: [] };
  const { base } = await startGateway(t, { db, config: { maxBodyBytes: 64 } });

  const res = await fetch(`${base}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'zcode/GLM-5.3', messages: [{ role: 'user', content: 'x'.repeat(200) }] }),
  });

  assert.equal(res.status, 413);
});

test('POST /v1/messages rejects malformed JSON with 400', async (t) => {
  const { base } = await startGateway(t);

  const res = await fetch(`${base}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{not json',
  });

  assert.equal(res.status, 400);
});

test('POST /v1/messages/count_tokens estimates input tokens', async (t) => {
  const { base } = await startGateway(t);

  const res = await fetch(`${base}/v1/messages/count_tokens`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'zcode/GLM-5.3',
      system: 'be terse',
      messages: [{ role: 'user', content: 'hello world, this is a token counting smoke test' }],
    }),
  });
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.equal(Number.isInteger(body.input_tokens), true);
  assert.ok(body.input_tokens > 5, `估算值太小：${body.input_tokens}`);
});

test('POST /v1/messages/count_tokens still validates the pool prefix', async (t) => {
  const { base } = await startGateway(t);

  const res = await fetch(`${base}/v1/messages/count_tokens`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'GLM-5.3', messages: [] }),
  });

  assert.equal(res.status, 400);
});
