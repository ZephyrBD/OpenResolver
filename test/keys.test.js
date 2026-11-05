import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createKey, findKeyBySecret, hashSecret } from '../auth/keys.mjs';

function emptyDb() {
  return { version: 1, keys: [] };
}

test('createKey returns the secret once and stores only its hash', () => {
  const db = emptyDb();

  const { full, key } = createKey(db, { name: 'dev', pools: ['zcode'] });

  assert.match(full, /^zsk_[A-Za-z0-9_-]{43}$/);
  assert.equal(key.keyHash, crypto.createHash('sha256').update(full).digest('hex'));
  assert.equal(key.prefix, full.slice(0, 12));
  assert.deepEqual(key.enabledPools, ['zcode']);
  assert.equal(key.enabled, true);
  assert.equal(db.keys.length, 1);
  assert.ok(!JSON.stringify(db).includes(full), 'db 里不能出现明文密钥');
});

test('findKeyBySecret matches the full secret only', () => {
  const db = emptyDb();
  const { full } = createKey(db, { name: 'dev' });

  assert.equal(findKeyBySecret(db, full)?.name, 'dev');
  assert.equal(findKeyBySecret(db, full.slice(0, -1)), null);
  assert.equal(findKeyBySecret(db, 'zsk_unknown'), null);
});

test('findKeyBySecret ignores disabled and expired keys', () => {
  const db = emptyDb();
  const disabled = createKey(db, { name: 'off' });
  disabled.key.enabled = false;
  const expired = createKey(db, { name: 'old', expiresAt: Date.now() - 1000 });

  assert.equal(findKeyBySecret(db, disabled.full), null);
  assert.equal(findKeyBySecret(db, expired.full), null);
});

test('hashSecret is stable sha256 hex', () => {
  assert.equal(
    hashSecret('zsk_abc'),
    crypto.createHash('sha256').update('zsk_abc').digest('hex'),
  );
  assert.match(hashSecret('zsk_abc'), /^[0-9a-f]{64}$/);
});
