// ZCode status()：签到判定看 balance 中 promo/daily 两类是否都在效，
// 并带出双来源的可领套餐与来源错误。

import test from 'node:test';
import assert from 'node:assert/strict';

import { startStub } from './helpers/stub.mjs';
import { createClaimer } from '../pools/zcode/claim.mjs';

const json = (res, obj, status = 200) => {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(obj));
};

const ACC = { id: 'z1', uid: 'uid-1', jwt: 'jwt-zc', deviceId: 'device-abc' };
const nowSec = () => Math.floor(Date.now() / 1000);

/** 按用例组装 balance / billing / marketing 三处响应。 */
async function makeStub(t, { activePlans = [], billing = [], marketing = { code: 0, data: { deliveries: [] } }, marketingStatus = 200 } = {}) {
  return startStub(t, async (req, res, rec) => {
    const path = rec.url.split('?')[0];
    if (path === '/api/v1/zcode-plan/billing/balance') return json(res, { code: 0, data: { plans: activePlans, balances: [{ remaining_units: 7, total_units: 10 }] } });
    if (path === '/api/v1/zcode-plan/billing/preview') return json(res, { code: 0, data: { plans: billing } });
    if (path === '/api/v1/marketing/touch') return json(res, marketing, marketingStatus);
    return json(res, { code: 0, data: {} });
  });
}

test('status: 只有 daily 在效 → checkedIn=false', async (t) => {
  const { origin } = await makeStub(t, {
    activePlans: [{ plan_id: 'zcode-v3-start-plan-0817', name: 'Start Plan', status: 'active', ends_at: nowSec() + 3600 }],
  });
  const s = await createClaimer({ origin }).status(ACC);
  assert.equal(s.supported, true);
  assert.equal(s.checkedIn, false);
  assert.deepEqual(s.details.activeKinds, ['daily']);
  assert.equal(s.credits, 7);
});

test('status: promo + daily 都在效 → checkedIn=true', async (t) => {
  const { origin } = await makeStub(t, {
    activePlans: [
      { plan_id: 'zcode-v3-start-plan-1101-wk', name: 'Weekend Build', status: 'active', ends_at: nowSec() + 3600 },
      { plan_id: 'zcode-v3-start-plan-0817', name: 'Start Plan', status: 'active', ends_at: nowSec() + 3600 },
    ],
  });
  const s = await createClaimer({ origin }).status(ACC);
  assert.equal(s.checkedIn, true);
  assert.deepEqual(s.details.activeKinds.sort(), ['daily', 'promo']);
});

test('status: balance 里已过期的 plan 不计入生效类型', async (t) => {
  const { origin } = await makeStub(t, {
    activePlans: [
      { plan_id: 'zcode-v3-start-plan-1101-wk', name: 'Weekend Build', status: 'active', ends_at: nowSec() - 60 },
      { plan_id: 'zcode-v3-start-plan-0817', name: 'Start Plan', status: 'active', ends_at: nowSec() + 3600 },
    ],
  });
  const s = await createClaimer({ origin }).status(ACC);
  assert.equal(s.checkedIn, false);
  assert.deepEqual(s.details.activeKinds, ['daily']);
});

test('status: marketing 不可用时仍 supported，并带出 sourceErrors', async (t) => {
  const { origin } = await makeStub(t, { marketingStatus: 500 });
  const s = await createClaimer({ origin }).status(ACC);
  assert.equal(s.supported, true);
  assert.ok(Array.isArray(s.details.sourceErrors));
  assert.ok(s.details.sourceErrors.some((e) => e.startsWith('marketing:')));
});

test('status: 可领套餐来自两个来源，只报窗口内的', async (t) => {
  const { origin } = await makeStub(t, {
    billing: [{ plan_id: 'bp', priority: 1, ends_at: nowSec() + 3600 }],
    marketing: {
      code: 0,
      data: {
        deliveries: [
          { campaign_id: 'c1', content: { action: { type: 'claim_zcode_plan', args: { plan_id: 'mp' } }, zcode_plan: { plan_id: 'mp', starts_at: nowSec() - 60, ends_at: nowSec() + 3600 } } },
          { campaign_id: 'c2', content: { action: { type: 'claim_zcode_plan', args: { plan_id: 'future' } }, zcode_plan: { plan_id: 'future', starts_at: nowSec() + 3600 } } },
        ],
      },
    },
  });
  const s = await createClaimer({ origin }).status(ACC);
  const ids = s.details.claimablePlans.map((p) => p.planId);
  assert.ok(ids.includes('bp'));
  assert.ok(ids.includes('mp'));
  assert.ok(!ids.includes('future'), '未开窗的不算可领');
  assert.equal(s.claimable, true);
  const mp = s.details.claimablePlans.find((p) => p.planId === 'mp');
  assert.deepEqual(mp.sources, ['marketing']);
});

test('status: 网络不可达 → supported=false，不抛', async () => {
  const s = await createClaimer({ origin: 'http://127.0.0.1:9' }).status(ACC);
  assert.equal(s.supported, true, 'status 只读，源失败降级为 sourceErrors 而不是整体不可用');
  assert.ok(s.details.sourceErrors.length >= 1);
});
