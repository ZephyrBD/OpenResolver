import test from 'node:test';
import assert from 'node:assert/strict';
import { createKey } from '../auth/keys.mjs';
import { extractSecret, authorize, AuthError, ipAllowed } from '../auth/guard.mjs';

function dbWith(opts = {}) {
  const db = { version: 1, keys: [] };
  const created = createKey(db, opts);
  return { db, created };
}

test('extractSecret accepts Bearer and x-api-key', () => {
  assert.equal(extractSecret({ authorization: 'Bearer zsk_abc' }), 'zsk_abc');
  assert.equal(extractSecret({ 'x-api-key': 'zsk_def' }), 'zsk_def');
  assert.equal(extractSecret({ authorization: 'Bearer zsk_abc', 'x-api-key': 'zsk_def' }), 'zsk_abc');
  assert.equal(extractSecret({}), null);
});

test('authorize allows loopback without a key when open mode is on', () => {
  const db = { version: 1, keys: [] };
  const res = authorize({ secret: null, ip: '127.0.0.1', db, config: { openMode: true } });
  assert.deepEqual(res, { key: null, openMode: true });
});

test('authorize rejects a keyless request from a remote address', () => {
  const db = { version: 1, keys: [] };
  assert.throws(
    () => authorize({ secret: null, ip: '203.0.113.9', db, config: { openMode: true } }),
    (err) => err instanceof AuthError && err.status === 401 && err.type === 'authentication_error',
  );
});

test('authorize rejects an unknown secret', () => {
  const { db } = dbWith();
  assert.throws(
    () => authorize({ secret: 'zsk_nope', ip: '127.0.0.1', db, config: {} }),
    (err) => err instanceof AuthError && err.status === 401,
  );
});

test('authorize enforces the pool allowlist', () => {
  const { db, created } = dbWith({ name: 'p', pools: ['zcode'] });
  const ok = authorize({ secret: created.full, ip: '127.0.0.1', db, config: {}, pool: 'zcode' });
  assert.equal(ok.key.name, 'p');
  assert.throws(
    () => authorize({ secret: created.full, ip: '127.0.0.1', db, config: {}, pool: 'trae' }),
    (err) => err instanceof AuthError && err.status === 403 && /trae/.test(err.message),
  );
});

test('authorize enforces the model allowlist', () => {
  const { db, created } = dbWith({ name: 'm' });
  created.key.modelAllowlist = ['GLM-5.3-Flash'];
  assert.doesNotThrow(() =>
    authorize({ secret: created.full, ip: '127.0.0.1', db, config: {}, model: 'GLM-5.3-Flash' }),
  );
  assert.throws(
    () => authorize({ secret: created.full, ip: '127.0.0.1', db, config: {}, model: 'GLM-5.3' }),
    (err) => err instanceof AuthError && err.status === 403,
  );
});

test('authorize enforces the ip allowlist with CIDR', () => {
  const { db, created } = dbWith({ name: 'ip' });
  created.key.ipAllowlist = ['10.0.0.0/8'];
  assert.doesNotThrow(() => authorize({ secret: created.full, ip: '10.1.2.3', db, config: {} }));
  assert.throws(
    () => authorize({ secret: created.full, ip: '192.168.1.5', db, config: {} }),
    (err) => err instanceof AuthError && err.status === 403,
  );
});

test('ipAllowed matches exact addresses, CIDR and loopback', () => {
  assert.equal(ipAllowed('127.0.0.1', ['127.0.0.1']), true);
  assert.equal(ipAllowed('::1', ['::1']), true);
  assert.equal(ipAllowed('10.255.0.1', ['10.0.0.0/8']), true);
  assert.equal(ipAllowed('11.0.0.1', ['10.0.0.0/8']), false);
  assert.equal(ipAllowed('10.0.0.1', []), true, '空清单 = 不限制');
});

test('authorize rejects keys over their token quota with 403', () => {
  const { db, created } = dbWith({ name: 'q', tokenQuota: 100 });
  created.key.usedTokens = 100;
  assert.throws(
    () => authorize({ secret: created.full, ip: '127.0.0.1', db, config: {} }),
    (err) => err instanceof AuthError && err.status === 403 && err.code === 'quota_exceeded',
  );
});
