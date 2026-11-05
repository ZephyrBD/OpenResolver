import test from 'node:test';
import assert from 'node:assert/strict';
import { startGateway } from './helpers/gateway.mjs';
import { startStub } from './helpers/stub.mjs';
import { createZcodePool } from '../pools/zcode/index.mjs';
import { deviceIdFor } from '../fingerprint.mjs';

const PROFILE = {
  system: [{ type: 'text', text: 'OFFICIAL SYSTEM' }],
  max_tokens: 128000,
  tool_choice: { type: 'auto' },
  thinking: { type: 'enabled' },
  output_config: { effort: 'low' },
};

const ACCOUNTS = [
  { id: 'z1', label: 'a1', jwt: 'jwt-1', uid: 'uid-1' },
  { id: 'z2', label: 'a2', jwt: 'jwt-2', uid: 'uid-2' },
];

function makePool(stub, overrides = {}, accounts = ACCOUNTS, rng = Math.random) {
  return createZcodePool({
    accounts: accounts.map((a) => ({ ...a })),
    profile: PROFILE,
    config: { origin: stub.origin, appVersion: '3.16.3', maxAttempts: 3, ...overrides },
    rng,
  });
}

/** rng 恒 0：weightedPick 必选权重最高的就绪账号（并列时取候选顺序第一个），完全确定。 */
const zeroRng = () => 0;

async function send(base, body, headers = {}) {
  return fetch(`${base}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

const ASK = { model: 'zcode/GLM-5.3', messages: [{ role: 'user', content: 'hi' }] };

test('non-stream request is forwarded and the JSON body passes through', async (t) => {
  const stub = await startStub(t, (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'pong' }],
        usage: { input_tokens: 3, output_tokens: 1 },
      }),
    );
  });
  const { base } = await startGateway(t, { pools: [makePool(stub, {}, [ACCOUNTS[0]])] });

  const res = await send(base, ASK);

  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/json');
  assert.equal((await res.json()).content[0].text, 'pong');

  const up = stub.requests[0];
  assert.equal(up.url, '/api/v1/zcode-plan/anthropic/v1/messages');
  assert.equal(up.headers.authorization, `Bearer ${ACCOUNTS[0].jwt}`);
  assert.equal(up.headers['x-platform'], 'linux-x64');
  assert.equal(up.headers['x-zcode-app-version'], '3.16.3');
  assert.equal(up.headers['anthropic-version'], '2023-06-01');
  assert.equal(up.headers['x-device-mid'], deviceIdFor(ACCOUNTS[0].uid));

  const sent = JSON.parse(up.body);
  assert.equal(sent.model, 'GLM-5.3');
  assert.equal(sent.stream, false);
  assert.deepEqual(sent.system, PROFILE.system);
});

test('SSE response is relayed byte for byte', async (t) => {
  const chunks = [
    'event: message_start\ndata: {"type":"message_start"}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"po"}}\n\n',
    'event: message_stop\ndata: {"type":"message_stop"}\n\n',
  ];
  const stub = await startStub(t, (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(chunks[0]);
    res.write(chunks[1]);
    res.end(chunks[2]);
  });
  const { base } = await startGateway(t, { pools: [makePool(stub)] });

  const res = await send(base, { ...ASK, stream: true });
  const text = await res.text();

  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/event-stream/);
  assert.equal(text, chunks.join(''));
  assert.equal(JSON.parse(stub.requests[0].body).stream, true);
});

test('a 5xx upstream is retried on the next account', async (t) => {
  const stub = await startStub(t, (req, res, rec, idx) => {
    if (idx === 0) {
      res.writeHead(502, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'bad gateway' } }));
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ content: [{ type: 'text', text: 'second' }] }));
  });
  const { base } = await startGateway(t, { pools: [makePool(stub)] });

  const res = await send(base, ASK);

  assert.equal(res.status, 200);
  assert.equal((await res.json()).content[0].text, 'second');
  assert.equal(stub.requests.length, 2);
  assert.notEqual(
    JSON.parse(stub.requests[0].body).metadata.user_id,
    JSON.parse(stub.requests[1].body).metadata.user_id,
    '重试必须换账号',
  );
});

test('a 3012 fingerprint rejection cools the account down and 429s the request', async (t) => {
  const stub = await startStub(t, (req, res) => {
    res.writeHead(403, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'risk control', biz_code: 3012 } }));
  });
  const pool = makePool(stub);
  const { base } = await startGateway(t, { pools: [pool] });

  const res = await send(base, ASK);

  assert.equal(res.status, 429);
  assert.match((await res.json()).error.message, /不可用/);
  assert.equal(stub.requests.length, 2, '两个账号各试一次');
  assert.notEqual(
    JSON.parse(stub.requests[0].body).metadata.user_id,
    JSON.parse(stub.requests[1].body).metadata.user_id,
  );

  const again = await send(base, ASK);
  assert.equal(again.status, 429);
  assert.equal(stub.requests.length, 2, '冷却期内不应再打上游');
});

test('a 200 response carrying a business error envelope is not passed through as success', async (t) => {
  const stub = await startStub(t, (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ code: 1005, msg: 'exceed quota limit', logid: 'x' }));
  });
  const { base } = await startGateway(t, { pools: [makePool(stub)] });

  const res = await send(base, ASK);
  const body = await res.json();

  assert.equal(res.status, 429);
  assert.equal(body.error.type, 'rate_limit_error');
  assert.match(body.error.message, /额度/);
  assert.equal(stub.requests.length, 2, '两个账号都应试过');
});

test('an account with manualWeight 0 is never picked', async (t) => {
  const stub = await startStub(t, (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ content: [{ type: 'text', text: 'only-second' }] }));
  });
  const accounts = [
    { ...ACCOUNTS[0], manualWeight: 0 },
    { ...ACCOUNTS[1] },
  ];
  const pool = createZcodePool({
    accounts,
    profile: PROFILE,
    config: { origin: stub.origin, appVersion: '3.16.3', maxAttempts: 3 },
  });
  const { base } = await startGateway(t, { pools: [pool] });

  await send(base, ASK);

  assert.equal(stub.requests.length, 1);
  assert.equal(stub.requests[0].headers.authorization, `Bearer ${ACCOUNTS[1].jwt}`);
});

test('requests sharing x-ugw-session stick to the same account', async (t) => {
  const stub = await startStub(t, (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ content: [{ type: 'text', text: 'pong' }] }));
  });
  // rng 恒 0 时调度器必选权重最高者。先把 z1 打进冷却，第一笔请求只能落 z2 并粘住；
  // 随后放行 z1（权重 50 > 用过的 z2 的 30），若无粘性第二笔必然换号，用例必红。
  const pool = makePool(stub, {}, ACCOUNTS, zeroRng);
  pool.scheduler.onUpstreamError(pool.accounts[0], { kind: 'server' }); // z1 冷却 60s
  const { base } = await startGateway(t, { pools: [pool] });

  const headers = { 'x-ugw-session': 'sess-a' };
  await (await send(base, ASK, headers)).text();
  assert.equal(stub.requests[0].headers.authorization, `Bearer ${ACCOUNTS[1].jwt}`, '前置：第一笔只能落 z2');
  pool.accounts[0].cooldownUntil = 0; // z1 恢复可用
  await (await send(base, ASK, headers)).text();

  assert.equal(stub.requests.length, 2);
  assert.equal(
    stub.requests[0].headers.authorization,
    stub.requests[1].headers.authorization,
    '同一会话必须落在同一账号',
  );
});

test('a failed sticky account is unbound and the retry can switch accounts', async (t) => {
  let failJwt = null;
  const stub = await startStub(t, (req, res) => {
    if (failJwt && req.headers.authorization === `Bearer ${failJwt}`) {
      res.writeHead(502, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'bad gateway' } }));
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ content: [{ type: 'text', text: 'ok' }] }));
  });
  const { base } = await startGateway(t, { pools: [makePool(stub, {}, ACCOUNTS, zeroRng)] });
  const headers = { 'x-ugw-session': 'sess-fail' };

  await (await send(base, ASK, headers)).text();
  const pinned = stub.requests[0].headers.authorization;
  assert.ok(pinned);

  failJwt = pinned.replace(/^Bearer /, '');
  const before = stub.requests.length;
  const res = await send(base, ASK, headers);
  assert.equal(res.status, 200);

  const attempts = stub.requests.slice(before);
  assert.equal(attempts.length, 2, '粘性账号失败后应解绑并换号');
  assert.equal(attempts[0].headers.authorization, pinned);
  assert.notEqual(attempts[1].headers.authorization, pinned);
});

test('a later attempt can fall back to a cooling untried account', async (t) => {
  const stub = await startStub(t, (req, res, rec, idx) => {
    if (idx === 0) {
      res.writeHead(500, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'boom' } }));
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ content: [{ type: 'text', text: 'fallback-ok' }] }));
  });
  const pool = makePool(stub);
  const cooling = pool.accounts[0];
  pool.scheduler.onUpstreamError(cooling, { kind: 'server' }); // 60s 冷却
  const ready = pool.accounts[1];
  const { base } = await startGateway(t, { pools: [pool] });

  const res = await send(base, ASK);

  assert.equal(res.status, 200);
  assert.equal(stub.requests.length, 2);
  assert.equal(stub.requests[0].headers.authorization, `Bearer ${ready.jwt}`, '第一次必须用可用账号');
  assert.equal(stub.requests[1].headers.authorization, `Bearer ${cooling.jwt}`, '第二次兜底到冷却但未试过的账号');
});

test('when every account is at max in-flight the 429 reports capacity, not cooldown', async (t) => {
  const stub = await startStub(t, (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ content: [{ type: 'text', text: 'should-not-happen' }] }));
  });
  const pool = makePool(stub, {}, [ACCOUNTS[0]]);
  pool.accounts[0].inFlight = 5;
  const { base } = await startGateway(t, { pools: [pool] });

  const res = await send(base, ASK);
  const body = await res.json();

  assert.equal(res.status, 429);
  assert.match(body.error.message, /并发已满/);
  assert.equal(stub.requests.length, 0);
});

test('an all-needs-login pool 429s with the no-account copy, not a recovery estimate', async (t) => {
  const stub = await startStub(t, (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ content: [{ type: 'text', text: 'should-not-happen' }] }));
  });
  const pool = makePool(stub);
  for (const acc of pool.accounts) pool.scheduler.onUpstreamError(acc, { kind: 'auth' });
  assert.equal(pool.scheduler.soonestRecovery(), pool.scheduler.now(), 'needs_login 账号不算恢复时间');

  await assert.rejects(
    () => pool.send({ req: { headers: {} }, body: ASK, res: {} }),
    (err) => {
      assert.equal(err.status, 429);
      assert.match(err.message, /没有可用账号，请检查账号状态/);
      assert.doesNotMatch(err.message, /恢复/);
      return true;
    },
  );
  assert.equal(stub.requests.length, 0);
});
