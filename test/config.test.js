import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../config.mjs';

test('loadConfig applies the documented defaults', () => {
  const cfg = loadConfig({});
  assert.equal(cfg.host, '0.0.0.0');
  assert.equal(cfg.port, 8790);
  assert.equal(cfg.maxBodyBytes, 8388608);
  assert.equal(cfg.maxAttempts, 3);
  assert.equal(cfg.openMode, true);
  assert.equal(cfg.zcodeOrigin, 'https://zcode.z.ai');
  assert.equal(cfg.zcodeAppVersion, '3.16.3');
  assert.match(cfg.dataDir, /data$/);
});

test('loadConfig parses env overrides into numbers and booleans', () => {
  const cfg = loadConfig({
    PORT: '9001',
    UGW_MAX_BODY_BYTES: '1024',
    UGW_MAX_ATTEMPTS: '5',
    UGW_OPEN_MODE: '0',
    UGW_DATA_DIR: '/tmp/ugw',
    ZCODE_UPSTREAM_ORIGIN: 'http://127.0.0.1:9999',
  });
  assert.equal(cfg.port, 9001);
  assert.equal(cfg.maxBodyBytes, 1024);
  assert.equal(cfg.maxAttempts, 5);
  assert.equal(cfg.openMode, false);
  assert.equal(cfg.dataDir, '/tmp/ugw');
  assert.equal(cfg.zcodeOrigin, 'http://127.0.0.1:9999');
});
