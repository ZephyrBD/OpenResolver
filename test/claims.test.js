// 各池自动领取/签到模块测试：真 HTTP 桩上游（test/helpers/stub.mjs），覆盖
// zcode / qoder / trae / workbuddy(cn+global) / codearts 的成功、幂等重复、
// 探测回退与网络失败（run 绝不抛出）路径。

import test from 'node:test';
import assert from 'node:assert/strict';

import { startStub } from './helpers/stub.mjs';

import { createClaimer as zcodeClaimer } from '../pools/zcode/claim.mjs';
import { createClaimer as qoderClaimer } from '../pools/qoder/claim.mjs';
import { createClaimer as traeClaimer } from '../pools/trae/checkin.mjs';
import { createClaimer as wbClaimer, claimWbWebActivities } from '../pools/workbuddy/checkin.mjs';
import { createClaimer as caClaimer } from '../pools/codearts/checkin.mjs';

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

const DEAD = 'http://127.0.0.1:9';

const endsAtSec = () => Date.now() / 1000 + 86_400;

test('zcode claim: 领取缺失类型、重复调用幂等、1003 过期路径', async (t) => {
  const st = {
    balance: [{ plan_id: 'zcode-v3-start-plan-1030-wk', name: 'Weekend Build', status: 'active', ends_at: endsAtSec() }],
  };
  const { origin, requests } = await startStub(t, async (req, res, rec) => {
    const path = rec.url.split('?')[0];
    if (path.endsWith('/billing/preview')) {
      return json(res, { code: 0, data: { plans: [{ plan_id: 'zcode-v3-coding-plan-pro', name: 'Coding Plan', entitlements: [] }] } });
    }
    if (path.endsWith('/billing/balance')) {
      return json(res, { code: 0, data: { plans: st.balance, balances: [] } });
    }
    if (path.endsWith('/billing/claim')) {
      const pid = bodyOf(rec).plan_id;
      if (pid === 'zcode-v3-start-plan-0817') {
        st.balance.push({ plan_id: pid, name: 'Start Plan', status: 'active', ends_at: endsAtSec() });
        return json(res, { code: 0, data: { plan: { plan_id: pid } } });
      }
      if (pid.includes('coding')) return json(res, { code: 1001, msg: 'plan not exist' });
      return json(res, { code: 1003, msg: 'target already exists' });
    }
    return json(res, { code: 0, data: {} });
  });

  const claimer = zcodeClaimer({ origin });
  const acc = { uid: 'u1', jwt: 'jwt-zc' };

  const r1 = await claimer.run(acc);
  assert.equal(r1.ok, true);
  assert.equal(r1.status, 'claimed');
  assert.deepEqual(r1.claimed, ['zcode-v3-start-plan-0817']);
  // promo（-wk）已生效 → 只补缺的 daily：preview 候选(coding) + 0817 兑底
  const claims1 = requests.filter((r) => r.url.includes('/billing/claim')).length;
  assert.equal(claims1, 2);
  assert.ok(requests.some((r) => r.headers['x-device-mid']), 'balance 必须带 x-device-mid');

  // 第二次：daily 已入 balance，两类都在效 → already 且不再发 claim
  const claimsBefore = requests.filter((r) => r.url.includes('/billing/claim')).length;
  const r2 = await claimer.run(acc);
  assert.equal(r2.status, 'already');
  assert.equal(requests.filter((r) => r.url.includes('/billing/claim')).length, claimsBefore);

  // status 只读汇总
  const s = await claimer.status(acc);
  assert.equal(s.supported, true);
  assert.equal(s.checkedIn, true);
});

test('zcode claim: 全部候选 1003 → already（体验包过期）', async (t) => {
  const { origin } = await startStub(t, async (req, res, rec) => {
    const path = rec.url.split('?')[0];
    if (path.endsWith('/billing/claim')) return json(res, { code: 1003, msg: 'target already exists' });
    return json(res, { code: 0, data: { plans: [], balances: [] } });
  });
  const r = await zcodeClaimer({ origin }).run({ uid: 'u2', jwt: 'j' });
  assert.equal(r.ok, true);
  assert.equal(r.status, 'already');
});

test('qoder claim: campaigns 领取 → replayed 幂等', async (t) => {
  const campaigns = [
    { id: 'c1', actionType: 'CLAIM_BENEFIT', claimStatus: 'CLAIMABLE', benefit: { amount: 50 } },
    { id: 'c2', actionType: 'OTHER', claimStatus: 'CLAIMABLE', benefit: { amount: 1 } },
  ];
  let claimCount = 0;
  const { origin, requests } = await startStub(t, async (req, res, rec) => {
    const path = rec.url.split('?')[0];
    if (path.endsWith('/me/campaigns')) {
      return json(res, { code: 0, data: { campaigns } });
    }
    if (path.endsWith('/me/campaigns/c1/claim')) {
      claimCount += 1;
      if (claimCount === 1) {
        campaigns[0].claimStatus = 'CLAIMED';
        return json(res, { status: 'CLAIMED', replayed: false, benefit: { kind: 'credit', amount: 50 }, expiresAt: '2026-12-01' });
      }
      return json(res, { status: 'CLAIMED', replayed: true, benefit: { kind: 'credit', amount: 50 } });
    }
    return json(res, { code: 0 });
  });

  const claimer = qoderClaimer({ openApiUrl: origin });
  const acc = { jobToken: 'qt' };
  assert.ok(requests.every((r) => !r.headers.authorization?.includes('undefined')));

  const r1 = await claimer.run(acc);
  assert.equal(r1.status, 'claimed');
  assert.deepEqual(r1.claimed, ['c1']);
  assert.equal(r1.credits, 50);
  assert.ok(requests.some((r) => r.headers['cosy-version'] === '1.0.1'));

  const r2 = await claimer.run(acc);
  assert.equal(r2.status, 'already');
  assert.equal(r2.credits, 0);

  // replayed=true → already，不再计分
  campaigns[0].claimStatus = 'CLAIMABLE';
  const r3 = await claimer.run(acc);
  assert.equal(r3.status, 'already');
  assert.equal(r3.credits, 0);
});

test('trae checkin: 未签 → claim → 回查翻转；假成功 → failed；9074/方案探测回退', async (t) => {
  await t.test('正常领取（credits 回退 status.credits）', async () => {
    let checkedIn = false;
    const { origin, requests } = await startStub(t, async (req, res, rec) => {
      const path = rec.url.split('?')[0];
      if (path.endsWith('/checkin_credits/status')) {
        return json(res, { code: 0, checked_in: checkedIn, did_checked_in: false, enable: true, credits: 100, extra_credits: 0 });
      }
      if (path.endsWith('/checkin_credits/claim')) {
        checkedIn = true;
        return json(res, { code: 0, message: 'ok' });
      }
      return json(res, { code: 0 });
    });
    const claimer = traeClaimer({ bizHost: origin });
    const r = await claimer.run({ jwt: 'tj' });
    assert.equal(r.status, 'claimed');
    assert.equal(r.credits, 100, 'claim 无数额 → 回退 status.credits');
    const statusCalls = requests.filter((r) => r.url.includes('status')).length;
    assert.ok(statusCalls >= 2, 'claim 后必须回查 status');
    const lastStatus = requests.filter((r) => r.url.includes('status')).at(-1);
    assert.ok(lastStatus.headers.authorization.startsWith('Cloud-IDE-JWT'));
  });

  await t.test('claim code=0 但状态未翻转 → failed（幂等假成功陷阱）', async () => {
    const { origin } = await startStub(t, async (req, res, rec) => {
      const path = rec.url.split('?')[0];
      if (path.endsWith('/checkin_credits/status')) {
        return json(res, { code: 0, checked_in: false, did_checked_in: false, enable: true, credits: 100 });
      }
      if (path.endsWith('/checkin_credits/claim')) return json(res, { code: 0, message: 'ok' });
      return json(res, { code: 0 });
    });
    const r = await traeClaimer({ bizHost: origin }).run({ jwt: 'tj' });
    assert.equal(r.ok, false);
    assert.equal(r.status, 'failed');
  });

  await t.test('9074 → 换 req_source body；非 9074 → 换鉴权方案', async () => {
    let claimedFlag = false;
    const { origin, requests } = await startStub(t, async (req, res, rec) => {
      const path = rec.url.split('?')[0];
      const isStatus = path.endsWith('/checkin_credits/status');
      if (!isStatus && !path.endsWith('/checkin_credits/claim')) return json(res, { code: 0 });
      const body = bodyOf(rec);
      const bearer = String(rec.headers.authorization || '').startsWith('Bearer');
      if (body.req_source === 2) return json(res, { code: 9074, message: 'activity rejected' });
      if (body.req_source === 1) {
        if (!bearer) return json(res, { code: 1001, message: 'bad token' }); // 非 9074 → 换 scheme
        if (isStatus) return json(res, { code: 0, checked_in: claimedFlag, enable: true, credits: 100 });
        claimedFlag = true;
        return json(res, { code: 0, message: 'ok', credits: 100 });
      }
      return json(res, { code: 9074, message: 'activity rejected' });
    });
    const r = await traeClaimer({ bizHost: origin }).run({ jwt: 'tj', variant: 'solo' });
    assert.equal(r.status, 'claimed');
    assert.equal(r.credits, 100, 'claim.credits 优先');
    assert.ok(requests.some((r) => String(r.headers.authorization).startsWith('Bearer')), '应回退到 Bearer 方案');
    const last = requests.at(-1);
    assert.equal(bodyOf(last).req_source, 1, '最终落在 req_source=1');
  });
});

test('workbuddy cn: 签到 + web 活动；already；400/10001；宿主回退', async (t) => {
  await t.test('签到成功 + web 补偿活动 + 首宿主 404 回退', async () => {
    let statusCount = 0;
    const { origin, requests } = await startStub(t, async (req, res, rec) => {
      const path = rec.url.split('?')[0];
      if (path.endsWith('/checkin-activity-status')) {
        statusCount += 1;
        if (statusCount === 1) return json(res, { code: 404, message: 'not found' }, 404);
        return json(res, { code: 0, data: { active: true, today_checked_in: false, streak_days: 3, daily_credit: 10 } });
      }
      if (path.endsWith('/daily-checkin')) return json(res, { code: 0, data: { credits: 10 } });
      if (path.endsWith('/compensation-status')) return json(res, { code: 0, data: { active: true, claimed: false } });
      if (path.endsWith('/claim-compensation')) return json(res, { code: 0, data: { credits: 30 } });
      if (path.endsWith('/check-gift-claimed')) return json(res, { code: 0, data: { active: true, claimed: true } });
      return json(res, { code: 0 });
    });
    const claimer = wbClaimer({ cnHosts: [origin, origin] });
    const r = await claimer.run({ jwt: 'wj', realm: 'cn' });
    assert.equal(r.status, 'claimed');
    assert.equal(r.credits, 40, '签到 10 + 补偿 30');
    assert.deepEqual(r.claimed, ['checkin', 'compensation']);
    const comp = requests.find((r) => r.url.includes('claim-compensation'));
    assert.equal(comp.headers['x-client-platform'], 'web');
    const statusReqs = requests.filter((r) => r.url.includes('checkin-activity-status'));
    assert.ok(statusReqs.length >= 2, '首宿主 404 后应换宿主重试');
  });

  await t.test('已签 → already，不发 daily-checkin', async () => {
    const { origin, requests } = await startStub(t, async (req, res, rec) => {
      const path = rec.url.split('?')[0];
      if (path.endsWith('/checkin-activity-status')) {
        return json(res, { code: 0, data: { active: true, checked_in: true, daily_credit: 10 } });
      }
      return json(res, { code: 0 });
    });
    const r = await wbClaimer({ cnHosts: [origin] }).run({ jwt: 'wj' });
    assert.equal(r.status, 'already');
    assert.ok(!requests.some((r) => r.url.includes('daily-checkin')));
  });

  await t.test('daily-checkin 400 + code 10001 → already', async () => {
    const { origin } = await startStub(t, async (req, res, rec) => {
      const path = rec.url.split('?')[0];
      if (path.endsWith('/checkin-activity-status')) {
        return json(res, { code: 0, data: { active: true, today_checked_in: false, daily_credit: 10 } });
      }
      if (path.endsWith('/daily-checkin')) return json(res, { code: 10001, message: '今日已签到' }, 400);
      return json(res, { code: 0 });
    });
    const r = await wbClaimer({ cnHosts: [origin], webActivities: false }).run({ jwt: 'wj' });
    assert.equal(r.status, 'already');
  });

  await t.test('global: 14051 → already；code 0 → claimed；404 → unsupported', async () => {
    const mk = (handler) => startStub(t, handler);
    const s1 = await mk(async (req, res, rec) => {
      if (rec.url.includes('/billing/ide/trial')) return json(res, { code: -1, message: 'err 14051 已领取' });
      return json(res, { code: 0 });
    });
    const r1 = await wbClaimer({ globalBase: s1.origin, name: 'workbuddy' }).run({ jwt: 'wj', realm: 'global' });
    assert.equal(r1.status, 'already');

    const s2 = await mk(async (req, res, rec) => {
      if (rec.url.includes('/billing/ide/trial')) return json(res, { code: 0, data: { credits: 20 } });
      return json(res, { code: 0 });
    });
    const r2 = await wbClaimer({ globalBase: s2.origin }).run({ jwt: 'wj', realm: 'global' });
    assert.equal(r2.status, 'claimed');
    assert.equal(r2.credits, 20);

    const s3 = await mk(async (req, res, rec) => json(res, { code: 0 }, 404));
    const r3 = await wbClaimer({ globalBase: s3.origin }).run({ jwt: 'wj', realm: 'global' });
    assert.equal(r3.status, 'unsupported');

    const s4 = await mk(async (req, res, rec) => json(res, { code: 0 }));
    const st = await wbClaimer({ globalBase: s4.origin }).status({ jwt: 'wj', realm: 'global' });
    assert.equal(st.supported, false, '国际版 status 只读不支持');
  });

  await t.test('claimWbWebActivities 独立导出', async () => {
    const { origin } = await startStub(t, async (req, res, rec) => {
      const path = rec.url.split('?')[0];
      if (path.endsWith('/compensation-status')) return json(res, { code: 0, data: { active: true, claimed: false } });
      if (path.endsWith('/claim-compensation')) return json(res, { code: 0, data: { credits: 30 } });
      if (path.endsWith('/check-gift-claimed')) return json(res, { code: 0, data: { active: true, claimed: false } });
      if (path.endsWith('/claim-gift')) return json(res, { code: 0, data: { credits: 5 } });
      return json(res, { code: 0 });
    });
    const out = await claimWbWebActivities({ jwt: 'wj' }, { endpoint: origin });
    assert.equal(out.length, 2);
    assert.deepEqual(out.map((o) => o.status), ['claimed', 'claimed']);
    assert.equal(out.reduce((s, o) => s + o.credits, 0), 35);
  });
});

// 真实上游 /v1/ops/delivery?channel=IDE 形状（2026-11 实测）：每日签到的 campaignId 会漂移
// （实测 34），新手礼是 AUTO_GRANT 由上游自动发放，邀请/学生认证不自动领取。
const DAILY_CAMPAIGN = (over = {}) => ({
  campaignId: 34,
  title: '每日签到领100积分',
  type: 'USER_LOGIN',
  claimable: true,
  status: 'ELIGIBLE',
  benefitUnit: 'CREDIT',
  benefitAmount: 100,
  pendingTotalAmount: 100,
  extra: {
    triggerMode: 'MANUAL_CLAIM',
    triggerEvent: 'user.login',
    startTime: '2026-01-01T00:00:00+08:00',
    endTime: '2099-12-31T23:59:59+08:00',
  },
  ...over,
});

const NEW_USER_CAMPAIGN = {
  campaignId: 4,
  title: '新人注册礼',
  type: 'NEW_USER_REGISTER',
  claimable: false,
  status: 'CLAIMED',
  benefitUnit: 'CREDIT',
  benefitAmount: 4000,
  extra: { triggerMode: 'AUTO_GRANT', triggerEvent: 'user.register' },
};

const OTHER_CAMPAIGNS = [
  { campaignId: 3, title: '邀请好友', type: 'INVITE_USER', claimable: true, status: 'ELIGIBLE', benefitUnit: 'CREDIT', benefitAmount: 200, extra: { triggerMode: 'MANUAL_CLAIM' } },
  { campaignId: 2, title: '学生认证', type: 'STUDENT_CERTIFIED', claimable: true, status: 'ELIGIBLE', benefitUnit: 'CREDIT', benefitAmount: 500, extra: { triggerMode: 'MANUAL_CLAIM' } },
  { campaignId: 5, title: '积分商城', type: 'POINT_MALL', claimable: true, status: 'ELIGIBLE', benefitUnit: 'POINT', benefitAmount: 9, extra: { triggerMode: 'MANUAL_CLAIM' } },
];

test('codearts: 每日签到按 type/triggerMode 选取（id 漂移到 34 也能领），AUTO_GRANT/邀请/学生/POINT 全过滤', async (t) => {
  let daily = DAILY_CAMPAIGN();
  const claimBodies = [];
  const confirmBodies = [];
  const { origin, requests } = await startStub(t, async (req, res, rec) => {
    const path = rec.url.split('?')[0];
    if (path.endsWith('/v1/ops/delivery')) {
      return json(res, { code: 0, data: { items: [daily, NEW_USER_CAMPAIGN, ...OTHER_CAMPAIGNS] } });
    }
    if (path.endsWith('/v1/ops/claim')) {
      claimBodies.push(bodyOf(rec));
      daily = { ...daily, status: 'CLAIMED', claimable: false };
      return json(res, { code: 0, data: {} });
    }
    if (path.endsWith('/v1/ops/confirm')) {
      confirmBodies.push(bodyOf(rec));
      daily = { ...daily, status: 'CONFIRMED', claimable: false };
      return json(res, { code: 0, data: {} });
    }
    return json(res, { code: 0 });
  });

  const claimer = caClaimer({ snapBase: origin });
  const acc = { accessKeyID: 'AKTEST', secretAccessKey: 'SKTEST', securityToken: 'tok' };
  const r = await claimer.run(acc);

  assert.equal(r.status, 'claimed');
  assert.deepEqual(r.claimed, ['34']);
  assert.equal(r.credits, 100, 'ELIGIBLE 取 pendingTotalAmount');
  assert.deepEqual(claimBodies.map((b) => b.campaignId), [34], '4(AUTO_GRANT)/3/2/5 都不 claim');
  assert.ok(claimBodies[0].idempotentKey.startsWith('claim_34_'));
  assert.deepEqual(confirmBodies.map((b) => b.campaignId), [34], '只 confirm 每日签到');
  assert.ok(requests.some((r) => r.headers['agent-type'] === 'PromptCenter'), '签名头必须带 Agent-Type');

  const s = await claimer.status(acc);
  assert.equal(s.supported, true);
  assert.equal(s.checkedIn, true, 'CONFIRMED 的每日签到 = 已签');
  assert.equal(s.claimable, false);
  assert.equal(s.credits, 100, '只统计 USER_LOGIN，不含新手 4000');
  assert.equal(s.details.items.length, 1, '邀请/学生/POINT/AUTO_GRANT 不进签到详情');
});

test('codearts: 每日签到 CLAIMED 且 claimable=false → 只补 confirm，不重复 claim', async (t) => {
  const claimBodies = [];
  const confirmBodies = [];
  const { origin } = await startStub(t, async (req, res, rec) => {
    const path = rec.url.split('?')[0];
    if (path.endsWith('/v1/ops/delivery')) {
      return json(res, {
        code: 0,
        data: { items: [DAILY_CAMPAIGN({ status: 'CLAIMED', claimable: false }), NEW_USER_CAMPAIGN] },
      });
    }
    if (path.endsWith('/v1/ops/claim')) {
      claimBodies.push(bodyOf(rec));
      return json(res, { code: 0, data: {} });
    }
    if (path.endsWith('/v1/ops/confirm')) {
      confirmBodies.push(bodyOf(rec));
      return json(res, { code: 0, data: {} });
    }
    return json(res, { code: 0 });
  });

  const r = await caClaimer({ snapBase: origin }).run({ accessKeyID: 'AK', secretAccessKey: 'SK', securityToken: 'tok' });
  assert.equal(r.status, 'claimed');
  assert.deepEqual(r.claimed, ['34']);
  assert.equal(claimBodies.length, 0, 'CLAIMED 不得重复 claim');
  assert.deepEqual(confirmBodies.map((b) => b.campaignId), [34]);
});

test('codearts: 注入 credsOf（STS 刷新 provider）→ 凭证不可用时不打上游', async (t) => {
  const { origin, requests } = await startStub(t, async (req, res) => json(res, { code: 0, data: { items: [] } }));
  let calls = 0;
  const claimer = caClaimer({
    snapBase: origin,
    credsOf: async () => {
      calls += 1;
      return null;
    },
  });
  const acc = { id: 'c1', accessKeyID: 'AK', secretAccessKey: 'SK', securityToken: 'tok' };

  const r = await claimer.run(acc);
  assert.equal(r.ok, false);
  assert.equal(r.status, 'failed');
  assert.deepEqual(r.claimed, []);
  assert.match(r.message, /凭证不可用/);

  const s = await claimer.status(acc);
  assert.equal(s.supported, false);
  assert.equal(s.checkedIn, false);
  assert.match(s.message, /凭证不可用/);

  assert.equal(requests.length, 0, '凭证缺失时不得回源');
  assert.equal(calls, 2, 'run/status 各解析一次凭证');

  // provider 抛错也必须走「绝不抛出」契约
  const throwing = caClaimer({
    snapBase: origin,
    credsOf: async () => {
      throw new Error('token 刷新失败');
    },
  });
  const tf = await throwing.run(acc);
  assert.equal(tf.ok, false);
  assert.equal(tf.status, 'failed');
  assert.match(tf.message, /token 刷新失败/);
  const ts = await throwing.status(acc);
  assert.equal(ts.supported, false);
  assert.match(ts.message, /token 刷新失败/);
});

test('codearts: 注入 credsOf 返回的刷新凭证用于签名（STS 过期也能领）', async (t) => {
  let daily = DAILY_CAMPAIGN();
  const { origin, requests } = await startStub(t, async (req, res, rec) => {
    const path = rec.url.split('?')[0];
    if (path.endsWith('/v1/ops/delivery')) {
      return json(res, { code: 0, data: { items: [daily] } });
    }
    if (path.endsWith('/v1/ops/claim')) {
      daily = { ...daily, status: 'CLAIMED', claimable: false };
      return json(res, { code: 0, data: {} });
    }
    if (path.endsWith('/v1/ops/confirm')) {
      daily = { ...daily, status: 'CONFIRMED', claimable: false };
      return json(res, { code: 0, data: {} });
    }
    return json(res, { code: 0 });
  });

  const claimer = caClaimer({
    snapBase: origin,
    credsOf: async () => ({ accessKeyID: 'AK-NEW', secretAccessKey: 'SK-NEW', securityToken: 'ST-NEW' }),
  });
  const r = await claimer.run({ id: 'c2', accessKeyID: 'AK-OLD', secretAccessKey: 'SK-OLD', securityToken: 'ST-OLD' });

  assert.equal(r.status, 'claimed');
  const delivery = requests.find((x) => x.url.includes('/v1/ops/delivery'));
  assert.match(delivery.headers.authorization, /Access=AK-NEW/, '签名必须用 provider 刷新的 AK');
  assert.equal(delivery.headers['x-security-token'], 'ST-NEW', '上游请求必须用刷新后的 STS');
});

test('codearts: 未传 snapBase 时默认走生产 snap-access（boot 漏传曾导致 Invalid URL）', async () => {
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(String(url));
    return { ok: true, text: async () => JSON.stringify({ code: 0, data: { items: [] } }) };
  };
  const claimer = caClaimer({ fetchImpl });
  const s = await claimer.status({ accessKeyID: 'AK', secretAccessKey: 'SK', securityToken: 'ST' });

  assert.equal(s.supported, true);
  assert.ok(urls.length >= 1, '至少应发起一次活动查询');
  assert.ok(
    urls[0].startsWith('https://snap-access.cn-north-4.myhuaweicloud.com/v1/ops/delivery?channel=IDE'),
    `默认 snapBase 漂移：${urls[0]}`,
  );
});

test('所有池 run() 网络失败绝不抛出', async () => {
  const results = await Promise.all([
    zcodeClaimer({ origin: DEAD }).run({ uid: 'u', jwt: 'j' }),
    qoderClaimer({ openApiUrl: DEAD }).run({ jobToken: 'j' }),
    traeClaimer({ bizHost: DEAD }).run({ jwt: 'j' }),
    wbClaimer({ cnHosts: [DEAD] }).run({ jwt: 'j', realm: 'cn' }),
    wbClaimer({ globalBase: DEAD }).run({ jwt: 'j', realm: 'global' }),
    caClaimer({ snapBase: DEAD }).run({ accessKeyID: 'a', secretAccessKey: 'b' }),
  ]);
  for (const r of results) {
    assert.equal(r.status, 'failed');
    assert.equal(r.ok, false);
    assert.ok(r.message);
  }
});
