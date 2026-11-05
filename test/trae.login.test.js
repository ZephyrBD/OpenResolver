import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startStub } from './helpers/stub.mjs';
import {
  buildLoginUrl,
  generateLoginLink,
  accountFromCallback,
  persistAccount,
} from '../tools/trae-login.mjs';
import { loadAccounts } from '../pools/zcode/accounts.mjs';

const NOW = 1_700_000_000_000;

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ugw-trae-login-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const HEX32 = /^[0-9a-f]{32}$/;
const HEX16 = /^[0-9a-f]{16}$/;

test('--link：URL 参数逐项断言 + pending-login.json 落盘', (t) => {
  const dir = tmpDir(t);
  const { url, machineId, deviceId, pendingFile } = generateLoginLink({ dataDir: dir });

  assert.match(machineId, HEX32);
  assert.match(deviceId, HEX32);
  assert.equal(path.basename(pendingFile), 'pending-login.json');
  const pending = JSON.parse(fs.readFileSync(pendingFile, 'utf8'));
  assert.equal(pending.machineId, machineId);
  assert.equal(pending.deviceId, deviceId);
  assert.ok(pending.createdAt);

  assert.ok(url.startsWith('https://www.trae.cn/authorization?'), url);
  const q = new URL(url).searchParams;
  assert.equal(q.get('client_id'), 'en1oxy7wnw8j9n');
  assert.equal(q.get('auth_from'), 'solo');
  assert.equal(q.get('login_channel'), 'native_ide');
  assert.equal(q.get('auth_type'), 'local');
  assert.equal(q.get('redirect'), '0');
  assert.equal(q.get('auth_callback_url'), 'http://127.0.0.1:18080/authorize');
  assert.equal(q.get('machine_id'), machineId);
  assert.equal(q.get('device_id'), deviceId);
  assert.equal(q.get('x_machine_id'), machineId);
  assert.equal(q.get('x_device_id'), deviceId);
  assert.equal(q.get('x_app_version'), '0.1.61');
  assert.equal(q.get('x_app_type'), 'stable');
  assert.match(q.get('login_trace_id') ?? '', HEX16);
});

test('--link：固定 machine/device/trace 可复现（buildLoginUrl 纯函数）', () => {
  const url = buildLoginUrl({ machineId: 'a'.repeat(32), deviceId: 'b'.repeat(32), traceId: 'c'.repeat(16) });
  const q = new URL(url).searchParams;
  assert.equal(q.get('machine_id'), 'a'.repeat(32));
  assert.equal(q.get('login_trace_id'), 'c'.repeat(16));
});

test('--callback：端到端（桩上游）落账号，machine/device id 与 pending 一致', async (t) => {
  const dir = tmpDir(t);
  const { machineId, deviceId } = generateLoginLink({ dataDir: dir });

  const stub = await startStub(t, (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    if (req.url.includes('ExchangeToken')) {
      res.end(JSON.stringify({ Result: { Token: 'jwt-1', RefreshToken: 'rt-2', TokenExpireAt: NOW + 86_400_000 } }));
    } else {
      res.end(JSON.stringify({ Result: { UserID: '37396015402', ScreenName: 'zephyr' } }));
    }
  });

  const userInfo = encodeURIComponent(JSON.stringify({ UserID: '37396015402', ScreenName: 'zephyr' }));
  const callback = `http://127.0.0.1:18080/authorize?refreshToken=rt-1&userInfo=${userInfo}`;

  const savedEnv = process.env.UGW_TRAE_API_HOST;
  process.env.UGW_TRAE_API_HOST = stub.origin;
  t.after(() => {
    if (savedEnv === undefined) delete process.env.UGW_TRAE_API_HOST;
    else process.env.UGW_TRAE_API_HOST = savedEnv;
  });

  const account = await accountFromCallback(callback, { dataDir: dir, now: () => NOW });
  assert.equal(account.id, 'trae-37396015402');
  assert.equal(account.uid, '37396015402');
  assert.equal(account.nickname, 'zephyr');
  assert.equal(account.jwt, 'jwt-1');
  assert.equal(account.refreshToken, 'rt-2', '轮换后的 refreshToken 落账号');
  assert.equal(account.expiresAt, NOW + 86_400_000);
  assert.equal(account.machineId, machineId, '9074 缓解：与 pending 同一对 id');
  assert.equal(account.deviceId, deviceId);
  assert.equal(account.state, 'ok');

  // ExchangeToken 请求体与 UA
  const rec = stub.requests[0];
  assert.match(rec.url, /ExchangeToken$/);
  assert.deepEqual(JSON.parse(rec.body), { ClientID: 'en1oxy7wnw8j9n', RefreshToken: 'rt-1', ClientSecret: '-', UserID: '' });
  assert.equal(rec.headers['user-agent'], 'Trae/0.1.61');

  // 落盘
  persistAccount(account, { dataDir: dir });
  const saved = loadAccounts(dir);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].machineId, machineId);
});

test('--callback：没有 pending 时报错（要求先 --link）', async (t) => {
  const dir = tmpDir(t);
  await assert.rejects(
    accountFromCallback('http://127.0.0.1:18080/authorize?refreshToken=rt', { dataDir: dir }),
    /--link/,
  );
});

test('persistAccount：同 id 覆盖不重复', (t) => {
  const dir = tmpDir(t);
  const a1 = { id: 'trae-u1', jwt: 'j1', enabled: true, state: 'ok' };
  persistAccount(a1, { dataDir: dir });
  persistAccount({ ...a1, jwt: 'j2' }, { dataDir: dir });
  const saved = loadAccounts(dir);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].jwt, 'j2');
});
