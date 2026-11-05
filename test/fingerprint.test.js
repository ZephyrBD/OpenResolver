import test from 'node:test';
import assert from 'node:assert/strict';
import { deviceIdFor, sessionIdFor, metadataUserId, requestId } from '../fingerprint.mjs';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

test('deviceIdFor derives a stable UUIDv4-shaped id per uid', () => {
  const a = deviceIdFor('uid-1');
  assert.match(a, UUID_V4);
  assert.equal(a, deviceIdFor('uid-1'));
  assert.notEqual(a, deviceIdFor('uid-2'));
});

test('sessionIdFor derives a stable session_<32 hex> per uid', () => {
  assert.match(sessionIdFor('uid-1'), /^session_[0-9a-f]{32}$/);
  assert.equal(sessionIdFor('uid-1'), sessionIdFor('uid-1'));
  assert.notEqual(sessionIdFor('uid-1'), sessionIdFor('uid-2'));
});

test('metadataUserId serialises device and session ids as JSON', () => {
  const parsed = JSON.parse(metadataUserId('uid-1'));
  assert.deepEqual(parsed, {
    device_id: deviceIdFor('uid-1'),
    account_uuid: '',
    session_id: sessionIdFor('uid-1'),
  });
});

test('requestId is a random 32-char hex', () => {
  assert.match(requestId(), /^[0-9a-f]{32}$/);
  assert.notEqual(requestId(), requestId());
});
