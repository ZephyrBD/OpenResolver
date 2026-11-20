// ZCode run() 主流程：双来源（billing + marketing）→ 择优 → 窗口 → claim → 回执。
// 真 HTTP 桩上游，全部假响应，不打真实账号。

import test from 'node:test';
import assert from 'node:assert/strict';

import { startStub } from './helpers/stub.mjs';
import { createClaimer } from '../pools/zcode/claim.mjs';

const json = (res, obj, status = 200) => {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(obj));
};

const bodyOf = (rec) => {
  try {
    return JSON.parse(rec.body || '{}');
  } catch {
    return {};
  }
};

const ACC = { id: 'z1', uid: 'uid-1', jwt: 'jwt-zc', deviceId: 'device-abc' };
const nowSec = () => Math.floor(Date.now() / 1000);

/** 常用桩：billing 可配、marketing 可配、claim 可配、事件上报恒成功。 */
function makeStub(t, { billing = [], marketing = null, claim = () => ({ code: 0, data: { plan: {} } }), events = true } = {}) {
  const state = { billing, claimCalls: [], confirms: [] };
  const promise = startStub(t, async (req, res, rec) => {
    const path = rec.url.split('?')[0];
    if (path === '/api/v1/event/report') return json(res, events ? { code: 0 } : { code: 500 }, events ? 200 : 500);
    if (path === '/api/v1/zcode-plan/billing/preview') return json(res, { code: 0, data: { plans: state.billing } });
    if (path === '/api/v1/marketing/touch') {
      if (marketing === null) return json(res, { code: 0, data: { deliveries: [] } });
      return json(res, marketing);
    }
    if (path === '/api/v1/marketing/touch/action') {
      state.confirms.push(bodyOf(rec));
      return json(res, { code: 0 });
    }
    if (path === '/api/v1/zcode-plan/billing/claim') {
      state.claimCalls.push(bodyOf(rec));
      return json(res, claim(bodyOf(rec)));
    }
    if (path === '/api/v1/zcode-plan/billing/balance') return json(res, { code: 0, data: { plans: [], balances: [] } });
    return json(res, { code: 0, data: {} });
  });
  return promise.then((stub) => ({ ...stub, state }));
}

const mk = (origin) => createClaimer({ origin });

test('只有 marketing 有活动、billing 为空 → claimed 并发出 confirm 回执', async (t) => {
  const stub = await makeStub(t, {
    marketing: {
      code: 0,
      data: {
        deliveries: [
          {
            campaign_id: 'camp-wk',
            priority: 5,
            content: {
              action: { type: 'claim_zcode_plan', args: { plan_id: 'plan-wk' } },
              zcode_plan: { plan_id: 'plan-wk', name: 'Weekend Build', starts_at: nowSec() - 60, ends_at: nowSec() + 86_400 },
            },
          },
        ],
      },
    },
    claim: () => ({ code: 0, data: { plan: { plan_id: 'plan-wk', ends_at: nowSec() + 86_400 } } }),
  });

  const r = await mk(stub.origin).run(ACC);

  assert.equal(r.ok, true);
  assert.equal(r.status, 'claimed');
  assert.deepEqual(r.claimed, ['plan-wk']);
  assert.equal(stub.state.claimCalls[0].plan_id, 'plan-wk');
  assert.deepEqual(stub.state.confirms, [{ campaign_id: 'camp-wk', action_type: 'confirm' }]);

  const claimReq = stub.requests.find((x) => x.url.endsWith('/billing/claim'));
  assert.equal(claimReq.headers['x-aliyun-captcha-verify-param'], undefined, '无 captcha 时不带该头');
  assert.equal(claimReq.headers['x-device-mid'], 'device-abc');
});

test('captcha 字段透传到领取请求头', async (t) => {
  const stub = await makeStub(t, {
    billing: [{ plan_id: 'p1', name: 'Start Plan', priority: 1, starts_at: nowSec() - 60, ends_at: nowSec() + 86_400 }],
  });
  const r = await mk(stub.origin).run({ ...ACC, captcha: 'cap-param-1' });
  assert.equal(r.status, 'claimed');
  const claimReq = stub.requests.find((x) => x.url.endsWith('/billing/claim'));
  assert.equal(claimReq.headers['x-aliyun-captcha-verify-param'], 'cap-param-1');
});

test('一源 500、另一源正常 → 仍 claimed，message 标注部分来源失败', async (t) => {
  const promise = startStub(t, async (req, res, rec) => {
    const path = rec.url.split('?')[0];
    if (path === '/api/v1/event/report') return json(res, { code: 0 });
    if (path === '/api/v1/marketing/touch') return json(res, { code: 1, msg: 'boom' }, 500);
    if (path === '/api/v1/zcode-plan/billing/preview') {
      return json(res, { code: 0, data: { plans: [{ plan_id: 'bp', priority: 1, ends_at: nowSec() + 3600 }] } });
    }
    if (path === '/api/v1/zcode-plan/billing/claim') return json(res, { code: 0, data: { plan: {} } });
    return json(res, { code: 0, data: {} });
  });
  const { origin } = await promise;

  const r = await mk(origin).run(ACC);
  assert.equal(r.status, 'claimed');
  assert.match(r.message, /部分来源失败/);
  assert.match(r.message, /marketing/);
});

test('两源都空 → 兜底走日期候选包，1003 判为 already', async (t) => {
  // billing 404 = 领取接口尚未部署，才触发日期编码兜底
  const { origin, requests } = await startStub(t, async (req, res, rec) => {
    const path = rec.url.split('?')[0];
    res.setHeader('content-type', 'application/json');
    if (path === '/api/v1/event/report') {
      res.statusCode = 200;
      return res.end('{"code":0}');
    }
    if (path === '/api/v1/zcode-plan/billing/preview') {
      res.statusCode = 404;
      return res.end('{"code":404,"msg":"not deployed"}');
    }
    if (path === '/api/v1/marketing/touch') {
      res.statusCode = 200;
      return res.end('{"code":0,"data":{"deliveries":[]}}');
    }
    if (path === '/api/v1/zcode-plan/billing/claim') {
      res.statusCode = 200;
      return res.end('{"code":1003,"msg":"target already exists"}');
    }
    res.statusCode = 200;
    res.end('{"code":0}');
  });

  const r = await createClaimer({ origin }).run(ACC);
  assert.equal(r.ok, true);
  assert.equal(r.status, 'already');
  const claims = requests.filter((x) => x.url.endsWith('/billing/claim'));
  assert.ok(claims.length > 0, '兜底候选必须真的尝试领取');
  assert.ok(
    claims.every((c) => /^zcode-v3-start-plan-(wk-)?\d{4}(-wk)?$/.test(JSON.parse(c.body).plan_id)),
    '兜底只调日期编码候选（两种 id 形态都要覆盖）',
  );
  const ids = claims.map((c) => JSON.parse(c.body).plan_id);
  assert.ok(ids.some((i) => i.includes('-wk-')), 'wk-先的形态（线上实际）必须包含');
  assert.ok(ids.some((i) => i.endsWith('-wk')), 'wk-后的形态（旧参考）也要保留');
});

test('活动窗口未开启 → failed，message 给出开启时间且不发 claim', async (t) => {
  const startAt = nowSec() + 3 * 86_400;
  const stub = await makeStub(t, {
    billing: [{ plan_id: 'future-plan', name: 'Future', priority: 9, starts_at: startAt, ends_at: startAt + 3600 }],
  });
  const r = await mk(stub.origin).run(ACC);
  assert.equal(r.ok, false);
  assert.equal(r.status, 'failed');
  assert.match(r.message, /活动窗口未开启/);
  assert.equal(stub.state.claimCalls.length, 0, '未开窗不得发起领取');
});

test('多个可领套餐按 priority 择优，未指定 ZCODE_PLAN_ID 时不领低优先的', async (t) => {
  const stub = await makeStub(t, {
    billing: [
      { plan_id: 'low-priority', priority: 1, ends_at: nowSec() + 3600 },
      { plan_id: 'high-priority', priority: 9, ends_at: nowSec() + 3600 },
    ],
  });
  const r = await mk(stub.origin).run(ACC);
  assert.equal(r.status, 'claimed');
  assert.deepEqual(stub.state.claimCalls.map((b) => b.plan_id), ['high-priority']);
});

test('3007 验证码未通过 → failed 且标记不可重试', async (t) => {
  const stub = await makeStub(t, {
    billing: [{ plan_id: 'p1', priority: 1, ends_at: nowSec() + 3600 }],
    claim: () => ({ code: 3007, msg: 'captcha failed' }),
  });
  const r = await mk(stub.origin).run(ACC);
  assert.equal(r.status, 'failed');
  assert.match(r.message, /验证码/);
  assert.equal(r.detail.retryable, false, '验证码错误当天不再重试');
});

test('1005 名额用完 → failed 但可重试', async (t) => {
  const stub = await makeStub(t, {
    billing: [{ plan_id: 'p1', priority: 1, ends_at: nowSec() + 3600 }],
    claim: () => ({ code: 1005, msg: 'quota exhausted' }),
  });
  const r = await mk(stub.origin).run(ACC);
  assert.equal(r.status, 'failed');
  assert.match(r.message, /次数|名额/);
  assert.notEqual(r.detail.retryable, false, '名额用完允许窗口内重试');
});

test('401 凭证失效 → failed 且标记不可重试', async (t) => {
  const promise = startStub(t, async (req, res, rec) => {
    const path = rec.url.split('?')[0];
    if (path === '/api/v1/event/report') return json(res, { code: 0 });
    if (path === '/api/v1/marketing/touch') return json(res, { code: 0, data: { deliveries: [] } });
    if (path === '/api/v1/zcode-plan/billing/preview') return json(res, { code: 401, msg: 'unauthorized' }, 401);
    return json(res, { code: 0, data: {} });
  });
  const { origin } = await promise;
  const r = await mk(origin).run(ACC);
  assert.equal(r.status, 'failed');
  assert.equal(r.detail.retryable, false);
});

test('领取后复查 marketing：活动位下线作为正向证据写进 message', async (t) => {
  let calls = 0;
  const promise = startStub(t, async (req, res, rec) => {
    const path = rec.url.split('?')[0];
    if (path === '/api/v1/event/report') return json(res, { code: 0 });
    if (path === '/api/v1/zcode-plan/billing/preview') return json(res, { code: 0, data: { plans: [] } });
    if (path === '/api/v1/marketing/touch') {
      calls += 1;
      if (calls === 1) {
        return json(res, { code: 0, data: { deliveries: [{ campaign_id: 'c1', content: { action: { type: 'claim_zcode_plan', args: { plan_id: 'p1' } } } }] } });
      }
      return json(res, { code: 0, data: { deliveries: [] } });
    }
    if (path === '/api/v1/marketing/touch/action') return json(res, { code: 0 });
    if (path === '/api/v1/zcode-plan/billing/claim') return json(res, { code: 0, data: { plan: {} } });
    return json(res, { code: 0, data: {} });
  });
  const { origin } = await promise;

  const r = await mk(origin).run(ACC);
  assert.equal(r.status, 'claimed');
  assert.match(r.message, /活动位已下线|正向下线|下线/);
});

test('confirm 回执失败不改判已确认的领取', async (t) => {
  const promise = startStub(t, async (req, res, rec) => {
    const path = rec.url.split('?')[0];
    if (path === '/api/v1/event/report') return json(res, { code: 0 });
    if (path === '/api/v1/zcode-plan/billing/preview') return json(res, { code: 0, data: { plans: [] } });
    if (path === '/api/v1/marketing/touch/action') return json(res, { code: 500, msg: 'confirm down' }, 500);
    if (path === '/api/v1/marketing/touch') {
      return json(res, { code: 0, data: { deliveries: [{ campaign_id: 'c1', content: { action: { type: 'claim_zcode_plan', args: { plan_id: 'p1' } } } }] } });
    }
    if (path === '/api/v1/zcode-plan/billing/claim') return json(res, { code: 0, data: { plan: {} } });
    return json(res, { code: 0, data: {} });
  });
  const { origin } = await promise;

  const r = await mk(origin).run(ACC);
  assert.equal(r.status, 'claimed', '回执失败不影响已确认的领取');
  assert.match(r.message, /回执/);
});

test('激活事件失败不阻断领取', async (t) => {
  const stub = await makeStub(t, {
    events: false,
    billing: [{ plan_id: 'p1', priority: 1, ends_at: nowSec() + 3600 }],
  });
  const r = await mk(stub.origin).run(ACC);
  assert.equal(r.status, 'claimed');
});

test('marketing 响应超过 4MiB → 该来源失败但不影响 billing', async (t) => {
  const promise = startStub(t, async (req, res, rec) => {
    const path = rec.url.split('?')[0];
    if (path === '/api/v1/event/report') return json(res, { code: 0 });
    if (path === '/api/v1/marketing/touch') {
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      const filler = 'x'.repeat(1024 * 1024);
      return res.end(JSON.stringify({ code: 0, data: { deliveries: [], blob: [filler, filler, filler, filler, filler] } }));
    }
    if (path === '/api/v1/zcode-plan/billing/preview') {
      return json(res, { code: 0, data: { plans: [{ plan_id: 'bp', priority: 1, ends_at: nowSec() + 3600 }] } });
    }
    if (path === '/api/v1/zcode-plan/billing/claim') return json(res, { code: 0, data: { plan: {} } });
    return json(res, { code: 0, data: {} });
  });
  const { origin } = await promise;

  const r = await mk(origin).run(ACC);
  assert.equal(r.status, 'claimed');
  assert.match(r.message, /大小上限/);
});

test('run() 网络完全不可达时绝不抛出', async () => {
  const r = await mk('http://127.0.0.1:9').run(ACC);
  assert.equal(r.ok, false);
  assert.equal(r.status, 'failed');
  assert.ok(r.message);
});

test('上游偶发 429 会重试，不让整个来源判死（实测多账号并发会遇到）', async (t) => {
  let billingHits = 0;
  const { origin } = await startStub(t, async (req, res, rec) => {
    const path = rec.url.split('?')[0];
    res.setHeader('content-type', 'application/json');
    if (path === '/api/v1/event/report') {
      res.statusCode = 200;
      return res.end('{"code":0}');
    }
    if (path === '/api/v1/marketing/touch') {
      res.statusCode = 200;
      return res.end('{"code":0,"data":{"deliveries":[]}}');
    }
    if (path === '/api/v1/zcode-plan/billing/preview') {
      billingHits += 1;
      // 前两次限流（非 JSON 页面），第三次正常
      if (billingHits <= 2) {
        res.statusCode = 429;
        res.setHeader('content-type', 'text/html');
        return res.end('<html>too many requests</html>');
      }
      res.statusCode = 200;
      return res.end(JSON.stringify({ code: 0, data: { plans: [{ plan_id: 'bp', priority: 1, ends_at: nowSec() + 3600 }] } }));
    }
    if (path === '/api/v1/zcode-plan/billing/claim') {
      res.statusCode = 200;
      return res.end('{"code":0,"data":{"plan":{}}}');
    }
    res.statusCode = 200;
    res.end('{"code":0,"data":{}}');
  });

  const r = await mk(origin).run(ACC);
  assert.equal(billingHits, 3, '429 必须重试');
  assert.equal(r.status, 'claimed', '重试成功后照常领取');
});
