// 配额详情契约测试：每个池的 get(acc) 返回统一详情结构
// {supported, ratio, source, fetchedAt, plan, periodEnd, details, checkin}，
// peek(acc) 仍同步返回最近 ratio。桩上游全部走 test/helpers/stub.mjs 真 HTTP。

import test from 'node:test';
import assert from 'node:assert/strict';
import { startStub } from './helpers/stub.mjs';
import { createQuotaCache as createZcodeQuotaCache } from '../pools/zcode/quota.mjs';
import { createQoderQuotaCache } from '../pools/qoder/quota.mjs';
import { createTraeQuotaCache } from '../pools/trae/quota.mjs';
import { createWorkbuddyQuotaCache } from '../pools/workbuddy/quota.mjs';
import { createCodeartsQuotaCache } from '../pools/codearts/quota.mjs';
import { createTokenManager, LOGIN_CONFIG_DEFAULTS } from '../pools/codearts/auth.mjs';
import { newDpopPrivateJwk } from '../pools/codearts/dpop.mjs';

const json = (res, obj, status = 200) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
};

// ---------- zcode ----------

test('zcode：balances 展开 per-bucket details，plans 取 active 最大 ends_at', async (t) => {
  const stub = await startStub(t, (req, res) => {
    json(res, {
      code: 0,
      data: {
        plans: [
          { plan_name: 'Free', ends_at: 1_800_000_000, is_active: false },
          { plan_name: 'GLM Pro', ends_at: 1_900_000_000, is_active: true },
          { plan_name: 'GLM Lite', ends_at: 1_850_000_000, is_active: true },
        ],
        balances: [
          { show_name: '每日赠送', remaining_units: 3, total_units: 10, plan_id: 'daily_free', period_end: 1_900_000_000 },
          { show_name: '促销包', remaining_units: 1, total_units: 10, plan_id: 'promo_2026', period_end: 1_900_000_001 },
        ],
      },
    });
  });
  const quota = createZcodeQuotaCache({ origin: stub.origin });
  const result = await quota.get({ id: 'z1', uid: 'uid-1', jwt: 'jwt-1' });

  assert.equal(result.supported, true);
  assert.equal(result.source, 'live');
  assert.equal(result.ratio, 0.2);
  assert.equal(result.plan, 'GLM Pro');
  assert.equal(result.periodEnd, 1_900_000_000_000);
  assert.equal(result.checkin, null);
  assert.equal(result.details.length, 2);
  assert.deepEqual(
    result.details.map((d) => [d.name, d.remaining, d.total, d.unit, d.percent, d.kind, d.expiresAt]),
    [
      ['每日赠送', 3, 10, 'tokens', 0.3, 'daily', 1_900_000_000_000],
      ['促销包', 1, 10, 'tokens', 0.1, 'promo', 1_900_000_001_000],
    ],
  );
  assert.equal(quota.peek({ id: 'z1' }), 0.2);
});

test('zcode：period_end 毫秒原样接受、秒归一为毫秒；plan_id 未知归类 other', async (t) => {
  const stub = await startStub(t, (req, res) => {
    json(res, {
      data: {
        balances: [{ show_name: '付费包', remaining_units: 8, total_units: 10, plan_id: 'abc123', period_end: 1_900_000_000_000 }],
      },
    });
  });
  const quota = createZcodeQuotaCache({ origin: stub.origin });
  const result = await quota.get({ id: 'z1' });
  assert.equal(result.details[0].kind, 'other');
  assert.equal(result.details[0].expiresAt, 1_900_000_000_000);
  assert.equal(result.plan, null);
  assert.equal(result.periodEnd, null);
});

// ---------- qoder ----------

test('qoder：userQuota + orgResourcePackage → details + expiresAt', async (t) => {
  const stub = await startStub(t, (req, res) => {
    json(res, {
      userQuota: { used: 30, total: 100, remaining: 70, unit: 'credit' },
      orgResourcePackage: { used: 900, total: 1000, remaining: 100, unit: 'credit' },
      expiresAt: '2026-12-31T23:59:59+08:00',
    });
  });
  const quota = createQoderQuotaCache({ mode: 'global', url: `${stub.origin}/quota` });
  const result = await quota.get({ id: 'q1', jobToken: 'job-1' });

  assert.equal(result.supported, true);
  assert.equal(result.source, 'live');
  assert.equal(result.ratio, 0.7, 'ratio 仍以 userQuota 为准');
  assert.equal(result.plan, null);
  assert.equal(result.periodEnd, Date.parse('2026-12-31T23:59:59+08:00'));
  assert.deepEqual(
    result.details.map((d) => [d.name, d.remaining, d.total, d.percent]),
    [
      ['用户额度', 70, 100, 0.7],
      ['组织资源包', 100, 1000, 0.1],
    ],
  );
  assert.equal(quota.peek({ id: 'q1' }), 0.7);
});

test('qoder：userQuota 缺失时 org-only 兜底 ratio；无 expiresAt → periodEnd null', async (t) => {
  const stub = await startStub(t, (req, res) => {
    json(res, { orgResourcePackage: { used: 250, total: 1000, remaining: 750, unit: 'credit' } });
  });
  const quota = createQoderQuotaCache({ mode: 'global', url: `${stub.origin}/quota` });
  const result = await quota.get({ id: 'q1' });
  assert.equal(result.ratio, 0.75);
  assert.equal(result.plan, null);
  assert.equal(result.periodEnd, null);
  assert.deepEqual(result.details.map((d) => d.name), ['组织资源包']);
});

test('qoder：total=0（额度耗尽）→ ratio 0 + plan + 9999 哨兵不上报', async (t) => {
  const stub = await startStub(t, (req, res) => {
    json(res, {
      userId: '01a1abcc-0000-0000-0000-000000000000',
      userType: 'personal_standard',
      usageType: 'credits',
      totalUsagePercentage: 0,
      isQuotaExceeded: true,
      expiresAt: 253402214400000,
      userQuota: { total: 0, used: 0, remaining: 0, percentage: 0, unit: 'credits' },
      isPlanQuotaProrated: false,
    });
  });
  const quota = createQoderQuotaCache({ mode: 'global', url: `${stub.origin}/quota` });
  const result = await quota.get({ id: 'q1', jobToken: 'job-1' });

  assert.equal(result.supported, true);
  assert.equal(result.source, 'live');
  assert.equal(result.ratio, 0, 'total=0 是有效零额度，不是失败');
  assert.equal(result.plan, 'personal_standard');
  assert.equal(result.periodEnd, null, '9999-12-31 哨兵不当作到期时间');
  assert.deepEqual(
    result.details.map((d) => [d.name, d.remaining, d.total, d.percent]),
    [['用户额度', 0, 0, null]],
  );
  assert.equal(quota.peek({ id: 'q1' }), 0);
});

test('qoder：无 userQuota 且无 orgResourcePackage → ratio null + unknown + error', async (t) => {
  const stub = await startStub(t, (req, res) => {
    json(res, {});
  });
  const quota = createQoderQuotaCache({ mode: 'global', url: `${stub.origin}/quota` });
  const result = await quota.get({ id: 'q1' });

  assert.equal(result.supported, true);
  assert.equal(result.ratio, null);
  assert.equal(result.source, 'unknown');
  assert.match(String(result.error), /缺少 userQuota/);
});

// ---------- trae ----------

test('trae：packs → details（三层 quota 探测/end_time），ratio 按实际剩余积分', async (t) => {
  const stub = await startStub(t, (req, res) => {
    if (req.url.startsWith('/trae/api/v2/ug/checkin_credits/status')) {
      return json(res, { checked_in: false, credits: 50, enable: true, streak_days: 3 });
    }
    json(res, {
      is_credits_billing: true,
      user_entitlement_pack_list: [
        {
          display_desc: 'SOLO 积分包',
          entitlement_base_info: { product_type: 1, end_time: 1_900_000_000, quota: { credits_limit: 30 } },
          usage: { credits_amount: 10 },
        },
        {
          entitlement_base_info: { product_type: 6, end_time: 1_900_000_100, quota: { credits_limit: 20 } },
          usage: { credits_amount: 5 },
        },
      ],
    });
  });
  const quota = createTraeQuotaCache({ bizHost: stub.origin, usageUrl: `${stub.origin}/ent`, checkinUrl: `${stub.origin}/trae/api/v2/ug/checkin_credits/status` });
  const result = await quota.get({ id: 't1', jwt: 'jwt-1' });

  assert.equal(result.supported, true);
  assert.equal(result.source, 'live');
  assert.equal(result.ratio, 0.7, 'credits_limit 30+20、已用 10+5 → remaining 35/50 = 0.7');
  assert.equal(result.plan, null);
  assert.equal(result.periodEnd, 1_900_000_100_000, 'periodEnd 取最晚包到期');
  assert.deepEqual(
    result.details.map((d) => [d.name, d.remaining, d.total, d.kind, d.expiresAt]),
    [
      ['SOLO 积分包', 20, 30, 'pro', 1_900_000_000_000],
      ['套餐 6', 15, 20, 'ultra', 1_900_000_100_000],
    ],
  );
  assert.deepEqual(result.details.map((d) => d.remaining), [20, 15], '明细 remaining 与 ratio 同源');
  assert.equal(result.details[0].percent, 20 / 30);
  assert.equal(result.details[1].percent, 15 / 20);
  assert.ok(result.details.every((d) => d.unit === 'credits'));
  assert.deepEqual(result.checkin, { checked_in: false, credits: 50, enable: true, streak_days: 3 });
  assert.equal(quota.peek({ id: 't1' }), 0.7);
});

test('trae：credits_limit === -1 → 整体不限量 ratio 1，明细保持 unlimited 语义', async (t) => {
  const stub = await startStub(t, (req, res) => {
    if (req.url.startsWith('/trae/api/v2/ug/checkin_credits/status')) return json(res, {});
    json(res, {
      is_credits_billing: true,
      user_entitlement_pack_list: [
        {
          display_desc: '不限量包',
          entitlement_base_info: { product_type: 4, end_time: 1_900_000_200, quota: {}, product_extra: { subscription_extra: { quota: { credits_limit: -1 } } } },
          usage: {},
        },
      ],
    });
  });
  const quota = createTraeQuotaCache({ bizHost: stub.origin, usageUrl: `${stub.origin}/ent`, checkinUrl: `${stub.origin}/trae/api/v2/ug/checkin_credits/status` });
  const result = await quota.get({ id: 't2', jwt: 'jwt-2' });

  assert.equal(result.ratio, 1);
  assert.equal(result.periodEnd, 1_900_000_200_000);
  assert.deepEqual(
    result.details.map((d) => [d.name, d.remaining, d.total, d.percent, d.kind]),
    [['不限量包', null, null, null, 'unlimited']],
  );
});

test('trae：隐藏/已取消/PROMO_CODE 包不计入 ratio 与明细', async (t) => {
  const stub = await startStub(t, (req, res) => {
    if (req.url.startsWith('/trae/api/v2/ug/checkin_credits/status')) return json(res, {});
    json(res, {
      is_credits_billing: true,
      user_entitlement_pack_list: [
        {
          display_desc: '有效包',
          entitlement_base_info: { product_type: 1, end_time: 1_900_000_000, quota: { credits_limit: 40 } },
          usage: { credits_amount: 10 },
        },
        {
          display_desc: '隐藏包',
          entitlement_base_info: { product_type: 6, is_hide: true, end_time: 1_900_000_300, quota: { credits_limit: -1 } },
          usage: {},
        },
        {
          display_desc: '已取消包',
          entitlement_base_info: { product_type: 5, status: 3, end_time: 1_900_000_300, quota: { credits_limit: 500 } },
          usage: { credits_amount: 0 },
        },
        {
          display_desc: 'PROMO_CODE',
          entitlement_base_info: { product_type: 3, end_time: 1_900_000_300, quota: { credits_limit: 900 } },
          usage: { credits_amount: 0 },
        },
      ],
    });
  });
  const quota = createTraeQuotaCache({ bizHost: stub.origin, usageUrl: `${stub.origin}/ent`, checkinUrl: `${stub.origin}/trae/api/v2/ug/checkin_credits/status` });
  const result = await quota.get({ id: 't3', jwt: 'jwt-3' });

  assert.equal(result.ratio, 0.75, '仅有效包 40/已用 10 参与 → 30/40');
  assert.equal(result.periodEnd, 1_900_000_000_000, 'periodEnd 也只看可见包');
  assert.deepEqual(result.details.map((d) => d.name), ['有效包']);
  assert.equal(result.details[0].remaining, 30);
});

// ---------- workbuddy ----------

test('workbuddy cn：get-user-resource 嵌套 Accounts → details + ratio；签到状态并查', async (t) => {
  const requests = [];
  const stub = await startStub(t, (req, res, rec) => {
    requests.push(rec);
    if (req.url === '/v2/billing/meter/get-user-resource') {
      const body = JSON.parse(rec.body);
      assert.equal(body.ProductCode, 'p_tcaca');
      assert.deepEqual(body.Status, [0, 3]);
      assert.equal(body.PageSize, 100);
      assert.match(body.PackageEndTimeRangeBegin, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
      assert.equal(body.PackageEndTimeRangeEnd, '2126-12-31 23:59:59');
      return json(res, {
        data: {
          Response: {
            Data: {
              Accounts: [
                { PackageName: '专业版月包', CycleCapacitySize: 1000, CycleCapacityRemain: 250, CycleEndTime: '2126-01-01 00:00:00' },
                { PackageName: '加油包', CapacitySize: 100, CapacityRemain: 50, DeductionEndTime: 1_900_000_000 },
              ],
            },
          },
        },
      });
    }
    if (req.url === '/v2/billing/meter/checkin-activity-status') {
      return json(res, { active: true, today_checked_in: true, streak_days: 7, daily_credit: 5, credits: 120 });
    }
    res.writeHead(404);
    res.end();
  });
  const quota = createWorkbuddyQuotaCache({ region: 'cn', endpoint: stub.origin, billingEndpoint: stub.origin, now: () => 1_760_000_000_000 });
  const result = await quota.get({ id: 'w1', uid: 'u1', jwt: 'jwt-1' });

  assert.equal(result.supported, true);
  assert.equal(result.source, 'live');
  assert.equal(result.ratio, 300 / 1100);
  assert.equal(result.periodEnd, 1_900_000_000_000, 'periodEnd 取最早的未来到期（加油包秒级时间戳）');
  assert.deepEqual(
    result.details.map((d) => [d.name, d.remaining, d.total, d.unit, d.kind]),
    [
      ['专业版月包', 250, 1000, 'credits', 'recurring'],
      ['加油包', 50, 100, 'credits', 'package'],
    ],
  );
  assert.deepEqual(result.checkin, {
    checked_in: true,
    credits: 120,
    active: true,
    streak_days: 7,
    daily_credit: 5,
  });
  assert.equal(requests.length, 2, 'cn 一次余额 + 一次签到');
  assert.equal(quota.peek({ id: 'w1' }), 300 / 1100);
});

test('workbuddy global：查余额但 checkin 恒 null（不打签到端点）', async (t) => {
  const stub = await startStub(t, (req, res) => {
    if (req.url === '/v2/billing/meter/get-user-resource') {
      return json(res, { Accounts: [{ PackageName: 'Global Pack', CycleCapacitySize: 500, CycleCapacityRemain: 125, CycleEndTime: '2126-06-01 00:00:00' }] });
    }
    res.writeHead(404);
    res.end();
  });
  const quota = createWorkbuddyQuotaCache({ region: 'global', endpoint: stub.origin, billingEndpoint: stub.origin });
  const result = await quota.get({ id: 'w2', uid: 'u2', jwt: 'jwt-2' });

  assert.equal(result.source, 'live');
  assert.equal(result.ratio, 0.25);
  assert.equal(result.checkin, null);
  assert.equal(stub.requests.every((r) => r.url !== '/v2/billing/meter/checkin-activity-status'), true);
});

// ---------- codearts ----------

const CREDIT_SAMPLE = {
  package: {
    status: 'normal',
    package_name_cn: '基础套餐',
    package_name_en: 'Basic',
    spec_code: 'spec-basic',
    package_url: 'https://example.com/package',
    is_credit_package: true,
    is_token_package: false,
  },
  end_date: '2026-12-31 23:59:59',
  metrics: [
    { name: 'usageTotalPackageCredit', package_credit_amount: 1000, package_credit_used: 250, package_credit_remain: 750, package_credit_expiring_amount: 50, value: 25 },
    { name: 'usageBasicPackageCredit', package_credit_amount: 800, package_credit_used: 200, package_credit_expiring_amount: 0 },
    { name: 'usageOnDemandPackageCredit', package_credit_amount: 200, package_credit_used: 50, package_credit_expiring_amount: 50 },
    { name: 'usageBonusPackageCredit', package_credit_amount: 0, package_credit_used: 0, package_credit_expiring_amount: 0 },
    { name: 'usageTokenChatMessages', usage_token_num: 0, package_token_amount: 0 },
  ],
};

const CAMPAIGNS_SAMPLE = {
  code: 0,
  data: {
    items: [
      { campaignId: 1, title: '新人礼', status: 'CONFIRMED', benefitUnit: 'credits', benefitAmount: 50, extra: { endTime: '2026-12-31 23:59:59' } },
      { campaignId: 2, title: '', status: 'CONSUMED', benefitUnit: '', benefitAmount: 20, extra: { endTime: '' } },
      { campaignId: 3, title: '未领取', status: 'PENDING', benefitUnit: 'credits', benefitAmount: 10, extra: {} },
    ],
  },
};

test('codearts：statistics/plugin → 积分套餐明细 + ratio + 活动 checkin', async (t) => {
  const stub = await startStub(t, (req, res) => {
    if (req.url.startsWith('/snap-manager/v1/statistics/plugin')) return json(res, CREDIT_SAMPLE);
    if (req.url.startsWith('/v1/ops/delivery')) return json(res, CAMPAIGNS_SAMPLE);
    res.writeHead(404);
    res.end();
  });
  const quota = createCodeartsQuotaCache({ snapBase: stub.origin });
  const result = await quota.get({ id: 'c1', accessKeyID: 'ak', secretAccessKey: 'sk', securityToken: 'st' });

  assert.equal(result.supported, true);
  assert.equal(result.source, 'live');
  assert.equal(result.ratio, 0.75, '剩余 750 / 总额 1000');
  assert.equal(result.plan, '基础套餐');
  assert.equal(result.periodEnd, Date.parse('2026-12-31T23:59:59+08:00'), '无时区 CN 时间按 +08:00 解析');
  assert.equal(result.error, undefined);
  assert.deepEqual(
    result.details.map((d) => [d.name, d.remaining, d.total, d.unit, d.kind]),
    [
      ['基础积分', 600, 800, 'credits', 'credit-basic'],
      ['按需积分', 150, 200, 'credits', 'credit-on-demand'],
      ['赠送积分', 0, 0, 'credits', 'credit-bonus'],
    ],
  );
  assert.equal(result.details[0].percent, 0.75);
  assert.equal(result.details[1].percent, 0.75);
  assert.equal(result.details[2].percent, null, 'total=0 时 percent 为 null');
  assert.deepEqual(result.checkin, { checkedIn: false, credits: 70, message: '' });
  assert.equal(quota.peek({ id: 'c1' }), 0.75);
  // 只取分类行，不得再叠加一条总额行（/user/balance 会 sum details.remaining）
  assert.equal(result.details.reduce((sum, d) => sum + d.remaining, 0), 750);

  // 身份头/session/签名形态（brief 逐字锁定）
  const creditReq = stub.requests.find((r) => r.url.startsWith('/snap-manager/v1/statistics/plugin'));
  assert.equal(creditReq.method, 'GET');
  assert.equal(creditReq.body, '', '请求体为空串');
  assert.equal(creditReq.headers['content-type'], 'application/json');
  assert.equal(creditReq.headers['app-id'], 'CodeAgent3.0');
  assert.equal(creditReq.headers['x-ot-function'], 'agent-general');
  assert.equal(creditReq.headers['plugin-name'], 'codemate_vscode');
  assert.equal(creditReq.headers['ide-name'], 'VSCode');
  assert.match(creditReq.headers['x-ot-trace-id'], /^[0-9a-f]{32}$/);
  assert.match(creditReq.headers['x-ot-span-id'], /^[0-9a-f]{16}$/);
  assert.match(creditReq.headers['x-snap-traceid'], /^[0-9a-f]{32}_[0-9a-f]{8}$/);
  assert.match(creditReq.headers['user-msg-id'], /^msg_[0-9a-f]{12}$/);
  assert.match(creditReq.headers['created-time'], /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  assert.match(creditReq.headers['x-ot-session-id'], /^ses_[0-9a-f]{24}$/);
  assert.equal(creditReq.headers['user-session-id'], creditReq.headers['x-ot-session-id']);
  const signed = /SignedHeaders=([^,]+)/.exec(creditReq.headers.authorization)?.[1] ?? '';
  for (const header of ['app-id', 'x-ot-session-id', 'plugin-name', 'x-snap-traceid', 'x-sdk-content-sha256']) {
    assert.ok(signed.includes(header), `${header} 必须参与签名`);
  }
});

test('codearts credit：session id 按 accessKeyID 稳定派生（不随请求变化）', async (t) => {
  const stub = await startStub(t, (req, res) => {
    if (req.url.startsWith('/snap-manager/v1/statistics/plugin')) return json(res, CREDIT_SAMPLE);
    if (req.url.startsWith('/v1/ops/delivery')) return json(res, CAMPAIGNS_SAMPLE);
    res.writeHead(404);
    res.end();
  });
  const quota = createCodeartsQuotaCache({ snapBase: stub.origin, ttlMs: 0 });
  const accA = { id: 'cA', accessKeyID: 'ak-A', secretAccessKey: 'sk', securityToken: 'st' };
  await quota.get(accA);
  await quota.get(accA);
  await quota.get({ id: 'cB', accessKeyID: 'ak-B', secretAccessKey: 'sk', securityToken: 'st' });

  const sessions = stub.requests
    .filter((r) => r.url.startsWith('/snap-manager/v1/statistics/plugin'))
    .map((r) => r.headers['x-ot-session-id']);
  assert.equal(sessions.length, 3);
  assert.equal(sessions[0], sessions[1], '同一 accessKeyID 的 session id 稳定');
  assert.notEqual(sessions[0], sessions[2], '不同 accessKeyID 派生不同 session');
});

test('codearts：慢上游被 timeoutMs 截断 → unknown 路径，不挂起 quota.get', async (t) => {
  // 两路端点都故意拖 1.5s，quota 只给 75ms 预算。
  const replyLater = (res, body) => {
    const timer = setTimeout(() => {
      if (!res.writableEnded) json(res, body);
    }, 1500);
    res.on('close', () => clearTimeout(timer));
  };
  const stub = await startStub(t, (req, res) => {
    if (req.url.startsWith('/snap-manager/v1/statistics/plugin')) return replyLater(res, CREDIT_SAMPLE);
    if (req.url.startsWith('/v1/ops/delivery')) return replyLater(res, CAMPAIGNS_SAMPLE);
    res.writeHead(404);
    res.end();
  });
  const quota = createCodeartsQuotaCache({ snapBase: stub.origin, timeoutMs: 75 });
  const started = Date.now();
  const result = await quota.get({ id: 'cSlow', accessKeyID: 'ak', secretAccessKey: 'sk', securityToken: 'st' });
  const elapsed = Date.now() - started;

  assert.ok(elapsed < 1000, `超时后应快速返回，实际 ${elapsed}ms`);
  assert.equal(result.source, 'unknown');
  assert.equal(result.supported, false);
  assert.equal(result.ratio, null);
  assert.ok(result.error, '超时错误进入 error 字段而非外抛');
  assert.equal(quota.peek({ id: 'cSlow' }), null);
  // 超时也走退避：退避期内再次 get 立即返回，不新增上游请求
  const afterFirst = stub.requests.length;
  const second = await quota.get({ id: 'cSlow', accessKeyID: 'ak', secretAccessKey: 'sk', securityToken: 'st' });
  assert.equal(second.source, 'unknown');
  assert.equal(stub.requests.length, afterFirst, '退避期内不回源');
});

test('codearts：无 usageTotalPackageCredit → supported false + reason，活动失败不影响 credit 结论', async (t) => {
  const stub = await startStub(t, (req, res) => {
    if (req.url.startsWith('/snap-manager/v1/statistics/plugin')) {
      return json(res, {
        package: { status: 'normal', package_name_cn: 'Token 套餐', is_token_package: true },
        metrics: [{ name: 'usageTokenChatMessages', usage_token_num: 10, package_token_amount: 100 }],
      });
    }
    res.writeHead(500); // 活动查询失败 → checkin null，但不能拖垮 credit
    res.end('delivery down');
  });
  const quota = createCodeartsQuotaCache({ snapBase: stub.origin });
  const result = await quota.get({ id: 'c2', accessKeyID: 'ak', secretAccessKey: 'sk', securityToken: 'st' });

  assert.equal(result.supported, false);
  assert.equal(result.ratio, null);
  assert.ok(result.reason && result.reason.length > 0);
  assert.equal(result.plan, 'Token 套餐', 'plan 仍取 packageName（套餐名可见）');
  assert.deepEqual(result.details, [], '无积分套餐 → 不输出 0/0 伪明细');
  assert.equal(result.checkin, null, '活动查询失败 → checkin null');
  assert.equal(quota.peek({ id: 'c2' }), null);
});

test('codearts：上游 500 → unknown + error，退避期内不再回源', async (t) => {
  let clock = 1_000_000;
  const stub = await startStub(t, (req, res) => {
    res.writeHead(500);
    res.end('{}');
  });
  const quota = createCodeartsQuotaCache({ snapBase: stub.origin, now: () => clock, ttlMs: 1000, backoffBaseMs: 60_000 });
  const first = await quota.get({ id: 'c3', accessKeyID: 'ak', secretAccessKey: 'sk' });

  assert.equal(first.source, 'unknown');
  assert.equal(first.supported, false);
  assert.equal(first.ratio, null);
  assert.ok(first.error, '错误消息非空');
  const afterFirst = stub.requests.length;
  assert.ok(afterFirst >= 1);

  clock += 1000;
  const second = await quota.get({ id: 'c3', accessKeyID: 'ak', secretAccessKey: 'sk' });
  assert.equal(second.source, 'unknown');
  assert.equal(stub.requests.length, afterFirst, '退避期内不回源');
  assert.equal(quota.peek({ id: 'c3' }), null);
});

test('codearts：成功后再失败 → stale 保留上一轮 details/ratio', async (t) => {
  let clock = 1_000_000;
  let fail = false;
  const stub = await startStub(t, (req, res) => {
    if (req.url.startsWith('/snap-manager/v1/statistics/plugin')) {
      if (fail) {
        res.writeHead(503);
        return res.end('down');
      }
      return json(res, CREDIT_SAMPLE);
    }
    if (req.url.startsWith('/v1/ops/delivery')) {
      if (fail) {
        res.writeHead(503);
        return res.end('down');
      }
      return json(res, CAMPAIGNS_SAMPLE);
    }
    res.writeHead(404);
    res.end();
  });
  const acc = { id: 'c4', accessKeyID: 'ak', secretAccessKey: 'sk' };
  const quota = createCodeartsQuotaCache({ snapBase: stub.origin, now: () => clock, ttlMs: 1000, backoffBaseMs: 60_000 });
  await quota.get(acc);

  fail = true;
  clock += 2000;
  const stale = await quota.get(acc);
  assert.equal(stale.source, 'stale');
  assert.equal(stale.ratio, 0.75);
  assert.ok(stale.error);
  assert.equal(stale.details.length, 3, '保留上一轮 details');
  assert.deepEqual(stale.checkin, { checkedIn: false, credits: 70, message: '' }, '保留上一轮 checkin');
});

// ---------- codearts 凭证刷新 / 明细兜底 / 空串数字 ----------

test('codearts quota：STS 过期 → token 端点刷一次、patch 经 provider 钩子回写、积分用新凭证', async (t) => {
  const tokenHits = [];
  const stub = await startStub(t, (req, res, rec) => {
    if (req.url === '/v1/oauth2/tokens') {
      assert.ok(rec.headers.dpop, 'refresh 必须带 DPoP proof');
      tokenHits.push(rec);
      return json(res, {
        user_id: 'u1',
        refresh_token: 'rt-new',
        credentials: {
          access_key_id: 'AK-NEW',
          secret_access_key: 'SK-NEW',
          security_token: 'ST-NEW',
          expiration: '2099-01-01T00:00:00Z',
        },
      });
    }
    if (req.url.startsWith('/snap-manager/v1/statistics/plugin')) return json(res, CREDIT_SAMPLE);
    if (req.url.startsWith('/v1/ops/delivery')) return json(res, CAMPAIGNS_SAMPLE);
    res.writeHead(404);
    res.end();
  });

  const tokens = createTokenManager({ fetchImpl: fetch, cfg: { ...LOGIN_CONFIG_DEFAULTS, stsHost: stub.origin } });
  const patches = [];
  const credsOf = async (acc) => {
    const { cred, patch } = await tokens.accessFor(acc);
    if (patch) {
      Object.assign(acc, patch);
      patches.push(patch);
    }
    return cred;
  };
  const quota = createCodeartsQuotaCache({ snapBase: stub.origin, credsOf });
  const acc = {
    id: 'cRefresh',
    accessKeyID: 'AK-OLD',
    secretAccessKey: 'SK-OLD',
    securityToken: 'ST-OLD',
    expiresAt: Date.now() - 60_000,
    refreshToken: 'rt-old',
    codeVerifier: 'verifier',
    dpopJwk: newDpopPrivateJwk(),
  };

  const result = await quota.get(acc);

  assert.equal(result.source, 'live');
  assert.equal(result.ratio, 0.75);
  assert.equal(tokenHits.length, 1, '凭证只刷新一次（两路查询共用）');
  assert.equal(patches.length, 1, 'patch 经 provider 钩子回写运行态');
  assert.equal(patches[0].securityToken, 'ST-NEW');
  assert.equal(acc.securityToken, 'ST-NEW', '账号运行态已换成新 STS');
  const creditReq = stub.requests.find((r) => r.url.startsWith('/snap-manager/v1/statistics/plugin'));
  assert.equal(creditReq.headers['x-security-token'], 'ST-NEW', '积分请求使用刷新后的 STS');
  assert.match(creditReq.headers.authorization, /Access=AK-NEW/, '签名使用刷新后的 AK');
});

test('codearts quota：STS 未过期 → 不回源 token 端点', async (t) => {
  let tokenHits = 0;
  const stub = await startStub(t, (req, res) => {
    if (req.url === '/v1/oauth2/tokens') {
      tokenHits++;
      return json(res, {});
    }
    if (req.url.startsWith('/snap-manager/v1/statistics/plugin')) return json(res, CREDIT_SAMPLE);
    if (req.url.startsWith('/v1/ops/delivery')) return json(res, CAMPAIGNS_SAMPLE);
    res.writeHead(404);
    res.end();
  });

  const tokens = createTokenManager({ fetchImpl: fetch, cfg: { ...LOGIN_CONFIG_DEFAULTS, stsHost: stub.origin } });
  const quota = createCodeartsQuotaCache({
    snapBase: stub.origin,
    credsOf: async (acc) => (await tokens.accessFor(acc)).cred,
  });
  const acc = {
    id: 'cFresh',
    accessKeyID: 'AK-CUR',
    secretAccessKey: 'SK-CUR',
    securityToken: 'ST-CUR',
    expiresAt: Date.now() + 3_600_000,
    refreshToken: 'rt-cur',
    codeVerifier: 'verifier',
    dpopJwk: newDpopPrivateJwk(),
  };

  const result = await quota.get(acc);

  assert.equal(result.source, 'live');
  assert.equal(tokenHits, 0, '有效期内的凭证不触发刷新');
  const creditReq = stub.requests.find((r) => r.url.startsWith('/snap-manager/v1/statistics/plugin'));
  assert.equal(creditReq.headers['x-security-token'], 'ST-CUR');
});

test('codearts quota：凭证 provider 返回 null → unknown + 明确原因，不回源积分', async (t) => {
  const stub = await startStub(t, (req, res) => {
    res.writeHead(500);
    res.end('should not be called');
  });
  const quota = createCodeartsQuotaCache({ snapBase: stub.origin, credsOf: async () => null });
  const result = await quota.get({ id: 'cNoCred' });

  assert.equal(result.source, 'unknown');
  assert.equal(result.supported, false);
  assert.equal(result.ratio, null);
  assert.match(result.error, /凭证不可用，请重新登录\/先发一次请求/);
  assert.equal(stub.requests.length, 0, '凭证缺失时两路都不打上游');
  assert.equal(quota.peek({ id: 'cNoCred' }), null);
});

test('codearts quota：仅总额指标 → 单条「积分池」明细（不与分类行双计）', async (t) => {
  const stub = await startStub(t, (req, res) => {
    if (req.url.startsWith('/snap-manager/v1/statistics/plugin')) {
      return json(res, {
        package: { status: 'normal' }, // 无 package_name → 回退「积分池」
        end_date: '2026-12-31 23:59:59',
        metrics: [
          { name: 'usageTotalPackageCredit', package_credit_amount: 1000, package_credit_used: 250, package_credit_remain: 750 },
        ],
      });
    }
    res.writeHead(404);
    res.end();
  });
  const quota = createCodeartsQuotaCache({ snapBase: stub.origin });
  const result = await quota.get({ id: 'cTotalOnly', accessKeyID: 'ak', secretAccessKey: 'sk', securityToken: 'st' });

  assert.equal(result.supported, true);
  assert.equal(result.ratio, 0.75);
  assert.equal(result.details.length, 1, '只输出一条总额行');
  assert.deepEqual(
    result.details.map((d) => [d.name, d.remaining, d.total, d.kind]),
    [['积分池', 750, 1000, 'credit']],
  );
  assert.equal(result.details.reduce((sum, d) => sum + d.remaining, 0), 750, '不得双计');
});

test('codearts quota：分类合计与总额不一致 → 退回单条总额行', async (t) => {
  const stub = await startStub(t, (req, res) => {
    if (req.url.startsWith('/snap-manager/v1/statistics/plugin')) {
      return json(res, {
        package: { status: 'normal', package_name_cn: '混合套餐' },
        metrics: [
          { name: 'usageTotalPackageCredit', package_credit_amount: 1000, package_credit_used: 250, package_credit_remain: 750 },
          { name: 'usageBasicPackageCredit', package_credit_amount: 500, package_credit_used: 100 },
          { name: 'usageOnDemandPackageCredit', package_credit_amount: 100, package_credit_used: 0 },
          { name: 'usageBonusPackageCredit', package_credit_amount: 0, package_credit_used: 0 },
        ],
      });
    }
    res.writeHead(404);
    res.end();
  });
  const quota = createCodeartsQuotaCache({ snapBase: stub.origin });
  const result = await quota.get({ id: 'cMismatch', accessKeyID: 'ak', secretAccessKey: 'sk', securityToken: 'st' });

  // 分类 Σ=600 ≠ 总额 1000 → 单条总额行，避免额度条与 /user/balance 口径分叉
  assert.deepEqual(result.details.map((d) => [d.name, d.remaining, d.total]), [['混合套餐', 750, 1000]]);
});

test('codearts credit：空串数字按缺失处理（remain 回退 total-used，value 回退比例）', async (t) => {
  const stub = await startStub(t, (req, res) => {
    if (req.url.startsWith('/snap-manager/v1/statistics/plugin')) {
      return json(res, {
        package: { status: 'normal', package_name_cn: '空串套餐' },
        end_date: '',
        metrics: [
          {
            name: 'usageTotalPackageCredit',
            package_credit_amount: '1000',
            package_credit_used: '250',
            package_credit_remain: '',
            value: '',
          },
        ],
      });
    }
    res.writeHead(404);
    res.end();
  });
  const quota = createCodeartsQuotaCache({ snapBase: stub.origin });
  const result = await quota.get({ id: 'cEmpty', accessKeyID: 'ak', secretAccessKey: 'sk', securityToken: 'st' });

  assert.equal(result.ratio, 0.75, 'remain "" 不得变 0');
  assert.equal(result.periodEnd, null, '空 end_date → periodEnd null');
  assert.equal(result.details.length, 1, '无分类指标 → 单条总额行');
  assert.equal(result.details[0].remaining, 750);
  assert.equal(result.details[0].percent, 0.75, 'value "" 回退 remaining/total');
});

// ---------- 失败路径：不外抛 + unknown/stale + 退避 ----------

test('各池上游失败：首败 unknown 不外抛，有旧值 stale，退避期内不回源', async (t) => {
  let clock = 1_000_000;
  const opts = { now: () => clock, ttlMs: 1000, backoffBaseMs: 60_000 };
  const zstub = await startStub(t, (req, res, rec, idx) => {
    if (idx === 0) return json(res, { data: { balances: [{ remaining_units: 5, total_units: 10 }] } });
    res.writeHead(503);
    res.end('down');
  });
  const zq = createZcodeQuotaCache({ origin: zstub.origin, ...opts });
  const zlive = await zq.get({ id: 'z1' });
  assert.equal(zlive.source, 'live');
  clock += 2000;
  const zstale = await zq.get({ id: 'z1' });
  assert.equal(zstale.source, 'stale');
  assert.equal(zstale.ratio, 0.5);
  assert.ok(zstale.error);
  assert.equal(zstale.details.length, 1, 'stale 保留上次 details');
  clock += 1000;
  await zq.get({ id: 'z1' });
  assert.equal(zstub.requests.length, 2, '退避期内不回源');

  const qstub = await startStub(t, (req, res) => {
    res.writeHead(500);
    res.end('{}');
  });
  const qq = createQoderQuotaCache({ mode: 'global', url: `${qstub.origin}/quota`, ...opts });
  const qfail = await qq.get({ id: 'q1' });
  assert.equal(qfail.source, 'unknown');
  assert.equal(qfail.ratio, null);
  assert.ok(qfail.error);
  clock += 1000;
  await qq.get({ id: 'q1' });
  assert.equal(qstub.requests.length, 1, '退避期内不回源');

  const tstub = await startStub(t, (req, res) => {
    res.writeHead(502);
    res.end('bad');
  });
  const tq = createTraeQuotaCache({ bizHost: tstub.origin, ...opts });
  const tfail = await tq.get({ id: 't1' });
  assert.equal(tfail.source, 'unknown');
  assert.equal(tfail.ratio, null);
  assert.ok(tfail.error);
  clock += 1000;
  await tq.get({ id: 't1' });
  assert.equal(tstub.requests.length, 1, '退避期内不回源');

  const wstub = await startStub(t, (req, res) => {
    res.writeHead(500);
    res.end('{}');
  });
  const wq = createWorkbuddyQuotaCache({ region: 'cn', endpoint: wstub.origin, billingEndpoint: wstub.origin, ...opts });
  const wfail = await wq.get({ id: 'w1' });
  assert.equal(wfail.source, 'unknown');
  assert.equal(wfail.ratio, null);
  assert.ok(wfail.error);
  clock += 1000;
  await wq.get({ id: 'w1' });
  assert.equal(wstub.requests.length, 1, '退避期内不回源');
  // codearts 的失败/退避路径见上面「上游 500 → unknown」独立用例（并行两路上游）。
});
