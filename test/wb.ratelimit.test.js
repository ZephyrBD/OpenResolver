import test from 'node:test';
import assert from 'node:assert/strict';
import { parseResetTime, createRateLimitRegistry, modelRateLimitMessage } from '../pools/workbuddy/ratelimit.mjs';

const NOW = Date.UTC(2026, 8, 22, 0, 0, 0); // 2026-09-22 08:00:00 UTC+8

test('parseResetTime：标准文案 "将在 YYYY-MM-DD HH:mm:ss UTC+8 重置" 按 UTC+8 解析', () => {
  const msg = '当前模型调用过于频繁，将在 2026-09-22 09:46:39 UTC+8 重置。您也可以切换其他模型继续使用';
  // 09:46:39 UTC+8 = 01:46:39 UTC
  assert.equal(parseResetTime(msg, NOW), Date.UTC(2026, 8, 22, 1, 46, 39));
});

test('parseResetTime：缺时间 / 无文案退 now+60s，绝不猜长窗口', () => {
  assert.equal(parseResetTime('当前模型调用过于频繁', NOW), NOW + 60_000);
  assert.equal(parseResetTime('', NOW), NOW + 60_000);
  assert.equal(parseResetTime(undefined, NOW), NOW + 60_000);
});

test('注册表：observe 后 fast-fail 生效；过期后放行', () => {
  const t = { value: NOW };
  const reg = createRateLimitRegistry({ now: () => t.value });
  const until = NOW + 10 * 60_000;
  reg.observe('acc-1', 'glm-5.2', until);
  assert.equal(reg.fastFail('acc-1', 'glm-5.2'), until, '窗口内快速失败');
  assert.equal(reg.fastFail('acc-1', 'other-model'), null, '同账号其它模型不受影响');
  assert.equal(reg.fastFail('acc-2', 'glm-5.2'), null, '同模型其它账号不受影响');
  t.value = until + 1;
  assert.equal(reg.fastFail('acc-1', 'glm-5.2'), null, '过声明时刻放行');
});

test('注册表：后续 6004 只延长不缩短', () => {
  const reg = createRateLimitRegistry({ now: () => NOW });
  reg.observe('a', 'm', NOW + 10 * 60_000);
  const kept = reg.observe('a', 'm', NOW + 60_000); // 更短的新窗口不得覆盖
  assert.equal(kept, NOW + 10 * 60_000);
  const extended = reg.observe('a', 'm', NOW + 20 * 60_000);
  assert.equal(extended, NOW + 20 * 60_000);
});

test('modelRateLimitMessage：带精确重置时间、不含字面 429', () => {
  const msg = modelRateLimitMessage('glm-5.2', Date.UTC(2026, 8, 22, 1, 46, 39));
  assert.match(msg, /09:46:39/);
  assert.match(msg, /UTC\+8/);
  assert.match(msg, /切换其他模型/);
  assert.doesNotMatch(msg, /429/);
});
