import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// F1（终审）：import-qoder.mjs 冒烟——进程可正常启动到网络层，不因缺 import 崩溃。
// exit code 非 0 可以（假 PAT / 无网络），但错误信息不能是 ReferenceError（path is not defined）。
test('import-qoder.mjs 冒烟：带假 PAT 走到网络层失败，不抛 ReferenceError', () => {
  const tool = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'tools', 'import-qoder.mjs');
  const result = spawnSync(process.execPath, [tool, '--pat', 'pt-smoke-fake', '--data', path.join('unused-smoke-data')], {
    timeout: 30_000,
    encoding: 'utf8',
  });

  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  assert.doesNotMatch(output, /path is not defined/, '缺 import 会在 path.resolve 处 ReferenceError');
  assert.doesNotMatch(output, /ReferenceError/, '不应有任何 ReferenceError');
  assert.notEqual(result.status, 0, '假 PAT 应在交换层失败退出（非 0）');
  assert.match(output, /交换失败|用法/, output.slice(0, 400));
});
