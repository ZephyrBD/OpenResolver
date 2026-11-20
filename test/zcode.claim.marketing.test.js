// ZCode 激活上报 + marketing 第二来源解析（参考 ZCode-Daily：report_activation /
// parse_marketing_plans / _walk_marketing_delivery）。真 HTTP 桩上游。

import test from 'node:test';
import assert from 'node:assert/strict';

import { startStub } from './helpers/stub.mjs';

import { reportActivation, parseMarketingPlans } from '../pools/zcode/claim.mjs';

const json = (res, obj, status = 200) => {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(obj));
};

const ACC = { id: 'z1', uid: 'uid-1', jwt: 'jwt-zc', deviceId: 'device-abc' };

test('reportActivation 依次上报 app_launch / app_daily_active，带账号设备指纹', async (t) => {
  const { origin, requests } = await startStub(t, async (req, res) => json(res, { code: 0 }));

  const out = await reportActivation(ACC, { origin, appVersion: '3.18.0' });

  assert.equal(out.ok, true);
  assert.equal(requests.length, 2);
  assert.ok(requests.every((r) => r.url === '/api/v1/event/report' && r.method === 'POST'));
  const bodies = requests.map((r) => JSON.parse(r.body));
  assert.deepEqual(bodies.map((b) => b.element_name), ['app_launch', 'app_daily_active']);
  for (const b of bodies) {
    assert.equal(b.device_mid, 'device-abc');
    assert.equal(b.user_id, 'uid-1');
    assert.equal(b.app_version, '3.18.0');
    assert.equal(b.client_language, 'zh-CN');
    assert.equal(b.event_region, 'app');
    assert.equal(b.source_element, '{}');
    assert.match(b.event_id, /^[0-9a-f-]{36}$/, '每条事件独立 event_id');
  }
});

test('reportActivation 上游失败只返回 ok:false，不抛', async (t) => {
  const { origin } = await startStub(t, async (req, res) => json(res, { code: 500 }, 500));
  const out = await reportActivation(ACC, { origin });
  assert.equal(out.ok, false);
  assert.ok(out.message);
});

test('reportActivation 缺 uid 时跳过上报', async () => {
  let calls = 0;
  const out = await reportActivation({ jwt: 'j' }, { fetchImpl: async () => { calls += 1; throw new Error('should not call'); } });
  assert.equal(out.ok, false);
  assert.equal(calls, 0);
});

test('parseMarketingPlans 递归收集 claim_zcode_plan 与嵌套 zcode_plan，并关联 campaign_id', () => {
  const payload = {
    code: 0,
    data: {
      deliveries: [
        {
          campaign_id: 'camp-1',
          priority: 7,
          content: {
            blocks: [
              { action: { type: 'claim_zcode_plan', args: { plan_id: 'zcode-v3-start-plan-1101-wk' } }, zcode_plan: { plan_id: 'zcode-v3-start-plan-1101-wk', name: 'Weekend Build', starts_at: 1_800_000_000, ends_at: 1_800_086_400 } },
            ],
          },
        },
        {
          campaign_id: 'camp-2',
          content: { action: { type: 'claim_zcode_plan', args: { plan_id: 'zcode-v3-start-plan-1101' } } },
        },
        { campaign_id: 'camp-3', content: { action: { type: 'open_url', args: { url: 'https://example.com' } } } },
      ],
    },
  };

  const { plans, error } = parseMarketingPlans(payload);
  assert.equal(error, '');
  assert.deepEqual(plans.map((p) => p.planId), ['zcode-v3-start-plan-1101-wk', 'zcode-v3-start-plan-1101']);
  const wk = plans[0];
  assert.equal(wk.name, 'Weekend Build');
  assert.equal(wk.priority, 7, 'delivery 的 priority 作为默认值');
  assert.deepEqual(wk.campaignIds, ['camp-1']);
  assert.equal(wk.startsAt, 1_800_000_000_000, '秒转毫秒');
  assert.deepEqual(wk.sources, ['marketing']);
  // 只有 action 没元数据的套餐也要能领
  assert.equal(plans[1].name, 'zcode-v3-start-plan-1101');
  assert.deepEqual(plans[1].campaignIds, ['camp-2']);
});

test('parseMarketingPlans 对环引用不死循环', () => {
  const loop = { campaign_id: 'camp-loop', action: { type: 'claim_zcode_plan', args: { plan_id: 'p-loop' } } };
  loop.self = loop;
  loop.child = { back: loop };
  const { plans, error } = parseMarketingPlans({ data: { deliveries: [loop] } });
  assert.equal(error, '');
  assert.deepEqual(plans.map((p) => p.planId), ['p-loop']);
});

test('parseMarketingPlans 超深嵌套被截断而不是抛错', () => {
  let node = { action: { type: 'claim_zcode_plan', args: { plan_id: 'deep-plan' } } };
  for (let i = 0; i < 40; i++) node = { wrap: node };
  const { plans } = parseMarketingPlans({ data: { deliveries: [{ campaign_id: 'c', content: node }] } });
  assert.equal(plans.length, 0, '超出深度上限的节点不再展开');
});

test('parseMarketingPlans 对非法 deliveries 返回 error', () => {
  assert.ok(parseMarketingPlans({ data: {} }).error);
  assert.ok(parseMarketingPlans({ data: { deliveries: 'nope' } }).error);
  assert.ok(parseMarketingPlans(null).error);
});

test('parseMarketingPlans 活动条数超过上限返回 error', () => {
  const deliveries = Array.from({ length: 33 }, (_, i) => ({ campaign_id: `c${i}` }));
  const { plans, error } = parseMarketingPlans({ data: { deliveries } });
  assert.equal(plans.length, 0);
  assert.match(error, /上限/);
});
