import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLoginFlow, pollLogin, accountFromPoll, persistAccount } from '../pools/zcode/onboard.mjs';
import { startStub } from './helpers/stub.mjs';

const TMP = 'C:\\Users\\LXY29\\AppData\\Local\\Temp\\opencode';

function mkJwt(payload) {
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${enc({ alg: 'HS256', typ: 'JWT' })}.${enc(payload)}.sig`;
}

test('zcode createLoginFlow：init 成功信封 → 返回 flow 字段 + 64hex pollToken', async (t) => {
  const stub = await startStub(t, (req, res) => {
    assert.equal(req.method, 'POST');
    assert.equal(req.url, '/api/v1/oauth/cli/init');
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({
      code: 0,
      data: { flow_id: 'flow-1', authorize_url: 'https://auth.z.ai/authorize?x=1', expires_at: 12345, poll_interval_sec: 3 },
      msg: 'ok',
    }));
  });
  const flow = await createLoginFlow({ origin: stub.origin });
  assert.equal(flow.flowId, 'flow-1');
  assert.equal(flow.authorizeUrl, 'https://auth.z.ai/authorize?x=1');
  assert.equal(flow.expiresAt, 12345);
  assert.equal(flow.pollIntervalSec, 3);
  assert.match(flow.pollToken, /^[0-9a-f]{64}$/);
  const rec = stub.requests[0];
  assert.equal(rec.headers.authorization, `Bearer ${flow.pollToken}`);
  assert.deepEqual(JSON.parse(rec.body), { provider: 'zai' });
});

test('zcode createLoginFlow：错误信封 code!==0 → 抛 msg', async (t) => {
  const stub = await startStub(t, (req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ code: 1001, msg: 'flow denied' }));
  });
  await assert.rejects(createLoginFlow({ origin: stub.origin }), /flow denied/);
});

test('zcode pollLogin：HTTP 202 → pending', async (t) => {
  const stub = await startStub(t, (req, res) => {
    assert.equal(req.url, '/api/v1/oauth/cli/poll/flow%2F1');
    res.statusCode = 202;
    res.end();
  });
  const out = await pollLogin({ origin: stub.origin, flowId: 'flow/1', pollToken: 'pt' });
  assert.deepEqual(out, { status: 'pending' });
});

test('zcode pollLogin：status pending 信封 → pending；ready → 账号字段齐全', async (t) => {
  const jwt = mkJwt({ user_id: 'user-abcdef12' });
  let call = 0;
  const stub = await startStub(t, (req, res) => {
    res.setHeader('content-type', 'application/json');
    if (call++ === 0) {
      res.end(JSON.stringify({ code: 0, data: { status: 'pending' }, msg: '' }));
    } else {
      res.end(JSON.stringify({
        code: 0,
        data: {
          status: 'ready',
          token: jwt,
          nick: 'Zephyr',
          email: 'a@b.com',
          zai: { access_token: 'zai-tok-1' },
          user: { user_id: 'fallback-uid' },
        },
        msg: '',
      }));
    }
  });
  const pending = await pollLogin({ origin: stub.origin, flowId: 'f', pollToken: 'pt' });
  assert.deepEqual(pending, { status: 'pending' });

  const ready = await pollLogin({ origin: stub.origin, flowId: 'f', pollToken: 'pt' });
  assert.equal(ready.status, 'ready');
  assert.equal(ready.account.uid, 'user-abcdef12', 'jwt 里的 user_id 优先于 user.user_id');
  assert.equal(ready.account.jwt, jwt);
  assert.equal(ready.account.zaiAccessToken, 'zai-tok-1');
  assert.equal(ready.account.label, 'Zephyr-user-abc');
  assert.equal(ready.account.realm, 'unknown');
  assert.equal(ready.account.enabled, true);
  assert.equal(ready.account.manualWeight, 10);
  assert.equal(typeof ready.account.id, 'string');
});

test('zcode accountFromPoll：手机号形态 → realm cn', () => {
  const acc = accountFromPoll({ token: mkJwt({ user_id: 'cnuser' }), phone: '13800138000' });
  assert.equal(acc.realm, 'cn');
  const acc2 = accountFromPoll({ token: mkJwt({ user_id: 'cnuser2' }), email: 'x@phone.local' });
  assert.equal(acc2.realm, 'cn');
});

test('zcode accountFromPoll：非法 jwt 且无 user_id → 抛错', () => {
  assert.throws(() => accountFromPoll({ token: 'not-a-jwt' }), /无法派生 uid/);
});

test('zcode persistAccount：按 uid 去重，重复落盘 skipped', (t) => {
  const dir = fs.mkdtempSync(path.join(TMP, 'zcode-onboard-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const a1 = accountFromPoll({ token: mkJwt({ user_id: 'uid-one' }) });
  const r1 = persistAccount(dir, a1);
  assert.equal(r1.skipped, false);
  assert.equal(r1.accounts.length, 1);

  const same = { ...accountFromPoll({ token: mkJwt({ user_id: 'uid-one' }) }), id: 'other-id' };
  const r2 = persistAccount(dir, same);
  assert.equal(r2.skipped, true, '同 uid 不落盘');
  assert.equal(r2.accounts.length, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'accounts.json'), 'utf8'))[0].id, a1.id);

  const b = accountFromPoll({ token: mkJwt({ user_id: 'uid-two' }) });
  const r3 = persistAccount(dir, b);
  assert.equal(r3.skipped, false);
  assert.equal(r3.accounts.length, 2);
});
