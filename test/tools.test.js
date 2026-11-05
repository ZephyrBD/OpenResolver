import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ugw-tools-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function run(script, args) {
  return execFileSync(process.execPath, [path.join(ROOT, script), ...args], {
    encoding: 'utf8',
    env: { ...process.env, UGW_OPEN_MODE: '1' },
  });
}

test('keygen prints the secret once and appends to keys.json', (t) => {
  const dataDir = tmpDir(t);

  const first = run('tools/keygen.mjs', ['--data', dataDir, '--name', 'dev', '--pools', 'zcode']);
  const secret = first.match(/zsk_[A-Za-z0-9_-]{43}/)?.[0];
  assert.ok(secret, 'stdout 必须包含明文密钥');
  assert.match(first, /只显示一次/);

  const db = JSON.parse(fs.readFileSync(path.join(dataDir, 'keys.json'), 'utf8'));
  assert.equal(db.keys.length, 1);
  assert.equal(db.keys[0].name, 'dev');
  assert.deepEqual(db.keys[0].enabledPools, ['zcode']);

  run('tools/keygen.mjs', ['--data', dataDir, '--name', 'second']);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, 'keys.json'), 'utf8')).keys.length, 2);
});

test('import-zcode maps source accounts and leaves the source untouched', (t) => {
  const dir = tmpDir(t);
  const source = path.join(dir, 'source-accounts.json');
  const payload = Buffer.from(JSON.stringify({ user_id: 'u-42' })).toString('base64url');
  fs.writeFileSync(
    source,
    JSON.stringify([
      { label: 'ZephyrZBD', email: 'a@x.com', jwt: `h.${payload}.s`, zaiAccessToken: 'tok', realm: 'intl' },
    ]),
  );
  const before = fs.readFileSync(source, 'utf8');
  const dataDir = path.join(dir, 'data');

  const out = run('tools/import-zcode.mjs', ['--from', source, '--data', dataDir]);
  assert.match(out, /导入 1 个/);

  const accounts = JSON.parse(fs.readFileSync(path.join(dataDir, 'pools', 'zcode', 'accounts.json'), 'utf8'));
  assert.equal(accounts.length, 1);
  assert.equal(accounts[0].uid, 'u-42');
  assert.equal(accounts[0].label, 'ZephyrZBD');
  assert.equal(accounts[0].jwt, `h.${payload}.s`);
  assert.equal(accounts[0].enabled, true);
  assert.equal(fs.readFileSync(source, 'utf8'), before, '源文件必须只读');

  const again = run('tools/import-zcode.mjs', ['--from', source, '--data', dataDir]);
  assert.match(again, /跳过 1 个已存在/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, 'pools', 'zcode', 'accounts.json'), 'utf8')).length, 1);
});
