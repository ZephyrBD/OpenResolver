import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadAccounts, saveAccounts } from '../pools/zcode/accounts.mjs';

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ugw-accounts-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('loadAccounts returns an empty list when the file does not exist', (t) => {
  assert.deepEqual(loadAccounts(tmpDir(t)), []);
});

test('saveAccounts round-trips through a single JSON file', (t) => {
  const dir = tmpDir(t);
  const accounts = [
    { id: 'z1', label: '主号', jwt: 'jwt-1', uid: 'uid-1', enabled: true },
    { id: 'z2', label: '小号', jwt: 'jwt-2', uid: 'uid-2', enabled: true },
  ];

  saveAccounts(dir, accounts);

  assert.deepEqual(loadAccounts(dir), accounts);
  assert.equal(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp')).length, 0, '不能残留临时文件');
});

test('saveAccounts tolerates a corrupt file by starting from an empty list', (t) => {
  const dir = tmpDir(t);
  fs.writeFileSync(path.join(dir, 'accounts.json'), '{broken');

  assert.deepEqual(loadAccounts(dir), []);
});
