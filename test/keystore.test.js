import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadKeys, saveKeys } from '../auth/store.mjs';
import { createKey } from '../auth/keys.mjs';

function tmpFile(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ugw-keys-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'keys.json');
}

test('loadKeys returns an empty database when the file is missing', (t) => {
  assert.deepEqual(loadKeys(tmpFile(t)), { version: 1, keys: [] });
});

test('saveKeys persists keys without the plaintext secret', (t) => {
  const file = tmpFile(t);
  const db = { version: 1, keys: [] };
  const { full } = createKey(db, { name: 'dev' });

  saveKeys(file, db);

  const restored = loadKeys(file);
  assert.equal(restored.keys.length, 1);
  assert.equal(restored.keys[0].name, 'dev');
  assert.ok(!fs.readFileSync(file, 'utf8').includes(full));
});
