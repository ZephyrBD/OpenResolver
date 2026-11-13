import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ZCODE_ORIGIN, ZCODE_APP_VERSION } from '../pools/zcode/constants.mjs';
import { createLoginFlow as zcCreateLoginFlow } from '../pools/zcode/onboard.mjs';

/** 01 §4 三件套：上游事实默认值唯一落点 constants.mjs，其它文件不得再写字面量。 */

test('zcode 上游默认 origin/appVersion 只在 constants.mjs 定义', async () => {
  // 仓库内除 constants.mjs 外不得再出现 origin/appVersion 字面量
  const dir = path.join(path.dirname(fileURL()), '..', 'pools', 'zcode');
  const offenders = [];
  for (const name of fs.readdirSync(dir)) {
    if (name === 'constants.mjs' || !name.endsWith('.mjs')) continue;
    const src = fs.readFileSync(path.join(dir, name), 'utf8');
    if (src.includes('https://zcode.z.ai') || src.includes("'3.16.3'")) offenders.push(name);
  }
  assert.deepEqual(offenders, [], `池文件不得内联上游默认值：${offenders.join(', ')}`);

  // onboard 默认参数确实引用 constants（签名不含字面量即可由上一步保证）
  assert.equal(ZCODE_ORIGIN, 'https://zcode.z.ai');
  assert.equal(ZCODE_APP_VERSION, '3.16.3');
  assert.ok(zcCreateLoginFlow, 'onboard createLoginFlow 存在');
});

function fileURL() {
  return decodeURIComponent(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
}
