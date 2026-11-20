// 签到窗口设置：autoClaimStartHour / autoClaimEndHour（默认 19 / 24，24 = 当天末）。
// 旧 autoClaimHour 仍可读，映射为 [hour, hour+1)。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_SETTINGS, loadSettings, patchSettings, clampSetting } from '../pools/settings.mjs';

function tmpFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ugw-settings-window-'));
  return { dir, file: path.join(dir, 'pool-settings.json') };
}

test('默认窗口为北京时间 19:00–23:59（end=24 表示当天末）', () => {
  const { file } = tmpFile();
  const settings = loadSettings({ file, env: {} });
  assert.equal(settings.autoClaimStartHour, 19);
  assert.equal(settings.autoClaimEndHour, 24);
  assert.equal('autoClaimHour' in DEFAULT_SETTINGS, false, '旧的单整点设置已移除');
});

test('环境变量可覆盖窗口起止', () => {
  const { file } = tmpFile();
  const settings = loadSettings({ file, env: { UGW_AUTO_CLAIM_START_HOUR: '20', UGW_AUTO_CLAIM_END_HOUR: '23' } });
  assert.equal(settings.autoClaimStartHour, 20);
  assert.equal(settings.autoClaimEndHour, 23);
});

test('旧 autoClaimHour 仍被读取，映射为 [hour, hour+1)', () => {
  const { file } = tmpFile();
  fs.writeFileSync(file, JSON.stringify({ autoClaimHour: 20 }));
  const settings = loadSettings({ file, env: {} });
  assert.equal(settings.autoClaimStartHour, 20);
  assert.equal(settings.autoClaimEndHour, 21);
});

test('旧环境变量 UGW_AUTO_CLAIM_HOUR 同样映射', () => {
  const { file } = tmpFile();
  const settings = loadSettings({ file, env: { UGW_AUTO_CLAIM_HOUR: '7' } });
  assert.equal(settings.autoClaimStartHour, 7);
  assert.equal(settings.autoClaimEndHour, 8);
});

test('新键优先于旧键', () => {
  const { file } = tmpFile();
  fs.writeFileSync(file, JSON.stringify({ autoClaimHour: 3, autoClaimStartHour: 20, autoClaimEndHour: 24 }));
  const settings = loadSettings({ file, env: { UGW_AUTO_CLAIM_HOUR: '1' } });
  assert.equal(settings.autoClaimStartHour, 20);
  assert.equal(settings.autoClaimEndHour, 24);
});

test('窗口起点 clamp 到 0–23，终点 clamp 到 0–24', () => {
  assert.equal(clampSetting('autoClaimStartHour', 99), 23);
  assert.equal(clampSetting('autoClaimStartHour', -1), 0);
  assert.equal(clampSetting('autoClaimEndHour', 99), 24);
  assert.equal(clampSetting('autoClaimEndHour', -1), 0);
});

test('终点早于起点时退化为终点 = 起点 + 1（不产生跨夜窗口）', () => {
  const { file } = tmpFile();
  fs.writeFileSync(file, JSON.stringify({ autoClaimStartHour: 20, autoClaimEndHour: 10 }));
  const settings = loadSettings({ file, env: {} });
  assert.equal(settings.autoClaimStartHour, 20);
  assert.equal(settings.autoClaimEndHour, 21);
});

test('patchSettings 落盘窗口字段且不改其它键', () => {
  const { file } = tmpFile();
  const base = loadSettings({ file, env: {} });
  const next = patchSettings({ file, settings: base, patch: { autoClaimStartHour: 19, autoClaimEndHour: 24 } });
  assert.equal(next.autoClaimStartHour, 19);
  assert.equal(next.autoClaimEndHour, 24);
  assert.equal(next.autoClaimEnabled, 1);
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(onDisk, next);
  assert.deepEqual(loadSettings({ file, env: {} }), next);
});
