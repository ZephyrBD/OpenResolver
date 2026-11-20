// ZCode 领套餐纯函数测试：不做网络，只钉合并/窗口/择优的语义。
// 参考 ZCode-Daily/zcode_cn_daily.py：merge_plan_sources / plan_window_state / pick_plan。

import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizePlan, mergePlans, planWindow, pickPlan } from '../pools/zcode/claim.mjs';

const SEC = 1000;
const T0 = 1_800_000_000 * SEC; // 固定基准，避免依赖真实时钟

test('normalizePlan 把上游字段归一（时间统一毫秒、缺省 priority 0）', () => {
  const plan = normalizePlan(
    { plan_id: 'p1', name: 'Start Plan', starts_at: T0 / SEC, ends_at: T0 / SEC + 3600, entitlements: [{ show_name: 'GLM', grant_units: 100, period: 'daily' }] },
    'billing',
  );
  assert.equal(plan.planId, 'p1');
  assert.equal(plan.name, 'Start Plan');
  assert.equal(plan.sources[0], 'billing');
  assert.equal(plan.startsAt, T0);
  assert.equal(plan.endsAt, T0 + 3600 * SEC);
  assert.equal(plan.priority, 0, '上游不返回 priority 时为 0');
  assert.deepEqual(plan.campaignIds, []);
});

test('normalizePlan 对缺少 plan_id 的条目返回 null', () => {
  assert.equal(normalizePlan({ name: 'no id' }, 'billing'), null);
  assert.equal(normalizePlan(null, 'billing'), null);
});

test('mergePlans 按 planId 去重：来源并集、priority 取大、空缺字段互补', () => {
  const billing = [normalizePlan({ plan_id: 'p1', name: 'Start Plan', priority: 1 }, 'billing')];
  const marketing = [normalizePlan({ plan_id: 'p1', priority: 5, ends_at: T0 / SEC }, 'marketing', { campaignIds: ['c1'] })];

  const merged = mergePlans(billing, marketing);
  assert.equal(merged.length, 1);
  assert.deepEqual(merged[0].sources, ['billing', 'marketing']);
  assert.deepEqual(merged[0].campaignIds, ['c1']);
  assert.equal(merged[0].priority, 5, 'priority 取较大值');
  assert.equal(merged[0].name, 'Start Plan', '已有名字不被空名字覆盖');
  assert.equal(merged[0].endsAt, T0, '空缺字段由另一来源补齐');
});

test('mergePlans 保留首次出现的顺序（同优先级取先出现）', () => {
  const a = [normalizePlan({ plan_id: 'first', priority: 3 }, 'billing')];
  const b = [normalizePlan({ plan_id: 'second', priority: 3 }, 'marketing')];
  assert.deepEqual(mergePlans(a, b).map((p) => p.planId), ['first', 'second']);
});

test('planWindow 三态', () => {
  const future = normalizePlan({ plan_id: 'f', starts_at: T0 / SEC + 60 }, 'billing');
  const active = normalizePlan({ plan_id: 'a', starts_at: T0 / SEC - 60, ends_at: T0 / SEC + 60 }, 'billing');
  const expired = normalizePlan({ plan_id: 'e', ends_at: T0 / SEC - 1 }, 'billing');
  assert.equal(planWindow(future, T0), 'future');
  assert.equal(planWindow(active, T0), 'active');
  assert.equal(planWindow(expired, T0), 'expired');
});

test('planWindow 无起止时间视为进行中', () => {
  assert.equal(planWindow(normalizePlan({ plan_id: 'x' }, 'billing'), T0), 'active');
});

test('planWindow 起点恰好等于现在算 active，终点恰好等于现在算 expired', () => {
  const atStart = normalizePlan({ plan_id: 's', starts_at: T0 / SEC }, 'billing');
  const atEnd = normalizePlan({ plan_id: 'e', ends_at: T0 / SEC }, 'billing');
  assert.equal(planWindow(atStart, T0), 'active');
  assert.equal(planWindow(atEnd, T0), 'expired');
});

test('pickPlan 取 priority 最高，同优先取先出现', () => {
  const plans = mergePlans(
    [normalizePlan({ plan_id: 'low', priority: 1 }, 'billing'), normalizePlan({ plan_id: 'high-a', priority: 9 }, 'billing')],
    [normalizePlan({ plan_id: 'high-b', priority: 9 }, 'marketing')],
  );
  assert.equal(pickPlan(plans).planId, 'high-a');
});

test('pickPlan 指定 wantedId 时只认它，不在列表里返回 null', () => {
  const plans = [normalizePlan({ plan_id: 'a', priority: 9 }, 'billing'), normalizePlan({ plan_id: 'b', priority: 1 }, 'billing')];
  assert.equal(pickPlan(plans, 'b').planId, 'b');
  assert.equal(pickPlan(plans, 'missing'), null);
});
