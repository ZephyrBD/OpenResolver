import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_SETTINGS, loadSettings, patchSettings } from '../pools/settings.mjs';

function tmpFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ugw-rates-'));
  return { dir, file: path.join(dir, 'pool-settings.json') };
}

test('conversion-rate settings default to 1.265 / 1 / 1', () => {
  assert.equal(DEFAULT_SETTINGS.wbCreditTokensRate, 1.265);
  assert.equal(DEFAULT_SETTINGS.qoderCreditTokensRate, 1);
  assert.equal(DEFAULT_SETTINGS.codeartsCreditTokensRate, 1, 'CodeArts 积分默认 1:1');
  const { file } = tmpFile();
  const settings = loadSettings({ file, env: {} });
  assert.equal(settings.wbCreditTokensRate, 1.265);
  assert.equal(settings.qoderCreditTokensRate, 1);
  assert.equal(settings.codeartsCreditTokensRate, 1);
});

test('conversion-rate settings accept env overrides as floats', () => {
  const settings = loadSettings({
    env: {
      UGW_WB_CREDIT_TOKENS_RATE: '1.5',
      UGW_QODER_CREDIT_TOKENS_RATE: '2.7',
      UGW_CODEARTS_CREDIT_TOKENS_RATE: '2.25',
    },
  });
  assert.equal(settings.wbCreditTokensRate, 1.5);
  assert.equal(settings.qoderCreditTokensRate, 2.7, '浮点不被取整');
  assert.equal(settings.codeartsCreditTokensRate, 2.25, 'CodeArts 浮点不被取整');
});

test('conversion-rate settings clamp: 0 and negatives floor at 0.0001, floats survive the file', () => {
  const { file } = tmpFile();
  fs.writeFileSync(
    file,
    JSON.stringify({
      wbCreditTokensRate: 0,
      qoderCreditTokensRate: -5,
      codeartsCreditTokensRate: -1,
      wbCreditTokensRateUnused: 1.2345,
    }),
  );
  const settings = loadSettings({ file, env: {} });
  assert.equal(settings.wbCreditTokensRate, 0.0001);
  assert.equal(settings.qoderCreditTokensRate, 0.0001);
  assert.equal(settings.codeartsCreditTokensRate, 0.0001);
});

test('a settings file float keeps its fractional part end to end', () => {
  const { file } = tmpFile();
  fs.writeFileSync(file, JSON.stringify({ qoderCreditTokensRate: 1.2345 }));
  const settings = loadSettings({ file, env: {} });
  assert.equal(settings.qoderCreditTokensRate, 1.2345);
});

test('patchSettings clamps bad rates and persists them', () => {
  const { file } = tmpFile();
  const base = loadSettings({ file, env: {} });
  const next = patchSettings({
    file,
    settings: base,
    patch: { wbCreditTokensRate: 0, qoderCreditTokensRate: -5, codeartsCreditTokensRate: 0, unknown: 1 },
  });
  assert.equal(next.wbCreditTokensRate, 0.0001);
  assert.equal(next.qoderCreditTokensRate, 0.0001);
  assert.equal(next.codeartsCreditTokensRate, 0.0001);
  assert.equal('unknown' in next, false);

  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(onDisk, next);
  assert.deepEqual(loadSettings({ file, env: {} }), next, '落盘后重新加载保持同值');
});

test('patchSettings preserves non-targeted rates and accepts positive values', () => {
  const { file } = tmpFile();
  const base = loadSettings({ file, env: {} });
  const next = patchSettings({ file, settings: base, patch: { wbCreditTokensRate: 1.5 } });
  assert.equal(next.wbCreditTokensRate, 1.5);
  assert.equal(next.qoderCreditTokensRate, base.qoderCreditTokensRate, '未提供的字段沿用旧值');
});
