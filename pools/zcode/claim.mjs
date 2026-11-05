// ZCode 福利领取（移植自 ZCode2api/zcgw-server.mjs :38-53 describePlan、
// :1457-1610 claimableFor/activeGrants/claimFor）。按额度 kind（promo/daily）
// 分别判断缺哪类只补哪类；活动包 id 带日期编码，候选跨北京日 ±1 天。
// run() 绝不抛出；同一账号的调用由调用方串行化。

import { deviceIdFor, sessionIdFor } from '../../fingerprint.mjs';

const DEFAULT_ORIGIN = 'https://zcode.z.ai';
const DEFAULT_APP_VERSION = '3.16.3';
const CLAIM_TIMEOUT_MS = 15_000;
const BUDGET_MS = 25_000;

/** 把 plan_id / plan 名译成额度类型（活动包/每日体验/付费/夜间）。 */
export function describePlan(id, name) {
  const s = `${id || ''} ${name || ''}`.toUpperCase();
  if (s.includes('WEEKEND') || s.includes('-WK')) return 'promo';
  if (s.includes('OFF-PEAK') || s.includes('OFFPEAK')) return 'offpeak';
  if (s.includes('START-PLAN') || s.includes('START PLAN')) return 'daily';
  if (s.includes('CODING-PLAN') || s.includes('CODING PLAN')) return 'paid';
  return 'other';
}

function claimHeaders(acc, appVersion) {
  return {
    accept: 'application/json',
    authorization: `Bearer ${acc.jwt}`,
    'x-api-key': acc.jwt,
    'x-device-mid': acc.deviceId || deviceIdFor(acc.uid),
    'x-session-id': acc.sessionId || sessionIdFor(acc.uid),
    'x-zcode-app-version': appVersion,
    'user-agent': `ZCode/${appVersion} ai-sdk/provider-utils/4.0.27 runtime/node.js/24`,
  };
}

/** 北京日（UTC+8）前后各一天的 MMDD 候选：0 点跳日时活动包 id 换日。 */
export function beijingStamps(nowMs = Date.now()) {
  const bj = nowMs + 8 * 3_600_000;
  return [0, -1, 1].map((delta) => {
    const d = new Date(bj + delta * 86_400_000);
    return `${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
  });
}

const okResult = (status, message, extra = {}) => ({ ok: true, status, claimed: [], credits: 0, message, ...extra });
const failResult = (message, extra = {}) => ({ ok: false, status: 'failed', claimed: [], credits: 0, message, ...extra });

export function createClaimer({
  fetchImpl = fetch,
  now = Date.now,
  origin = DEFAULT_ORIGIN,
  appVersion = DEFAULT_APP_VERSION,
  budgetMs = BUDGET_MS,
  timeoutMs = CLAIM_TIMEOUT_MS,
} = {}) {
  async function get(acc, path) {
    const res = await fetchImpl(`${origin}${path}`, {
      headers: claimHeaders(acc, appVersion),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`HTTP ${res.status} 响应不是合法 JSON`);
    }
  }

  async function previewPlans(acc) {
    const j = await get(acc, `/api/v1/zcode-plan/billing/preview?app_version=${appVersion}&platform=win32-x64`);
    const plans = (j?.data?.plans ?? []).map((p) => ({
      planId: p.plan_id,
      name: p.name,
      kind: describePlan(p.plan_id, p.name),
      entitlements: (p.entitlements ?? []).map((e) => ({ model: e.show_name, grant: e.grant_units, period: e.period })),
    }));
    return plans;
  }

  /** 当前生效中的 grant（promo 等非日包在效即算已领）。 */
  async function activeGrants(acc) {
    try {
      const j = await get(acc, `/api/v1/zcode-plan/billing/balance?app_version=${appVersion}`);
      const sec = now() / 1000;
      return (j?.data?.plans ?? []).filter((p) => p.status === 'active' && (p.ends_at ?? 0) > sec);
    } catch {
      return [];
    }
  }

  async function claimOne(acc, planId) {
    const res = await fetchImpl(`${origin}/api/v1/zcode-plan/billing/claim`, {
      method: 'POST',
      headers: { ...claimHeaders(acc, appVersion), 'content-type': 'application/json' },
      body: JSON.stringify({ plan_id: planId }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch {
      return { code: -1, msg: `HTTP ${res.status} ${text.slice(0, 80) || '(空响应)'}` };
    }
  }

  async function run(acc, { force = false } = {}) {
    try {
      const active = await activeGrants(acc);
      const activeKinds = new Set(active.map((p) => describePlan(p.plan_id, p.name)));

      // 两类常领额度都在效才算真的不用领；force 只跳过早退，仍不复领在效类型。
      if (activeKinds.has('daily') && activeKinds.has('promo')) {
        const first = active[0];
        return okResult('already', first ? `${first.name} 已生效` : '已领取', {
          detail: { activeKinds: [...activeKinds] },
        });
      }

      const candidates = [];
      const missingKinds = [];
      const plans = await previewPlans(acc);
      for (const p of plans) candidates.push(p.planId);
      if (!activeKinds.has('promo')) {
        for (const stamp of beijingStamps(now())) candidates.push(`zcode-v3-start-plan-${stamp}-wk`);
        missingKinds.push('promo');
      }
      if (!activeKinds.has('daily')) {
        candidates.push('zcode-v3-start-plan-0817');
        missingKinds.push('daily');
      }
      if (!missingKinds.length) {
        return okResult('already', '已领取', { detail: { activeKinds: [...activeKinds] } });
      }

      const claimed = [];
      const dup = [];
      const tried = [];
      const deadline = now() + budgetMs;
      for (const planId of [...new Set(candidates)]) {
        if (now() > deadline) {
          tried.push({ planId: '(...)', code: 'budget', msg: '候选太多，已超时中止' });
          break;
        }
        const j = await claimOne(acc, planId);
        const msg = j?.data?.message || j?.msg || '';
        tried.push({ planId, code: j?.code, msg });
        if (j?.code === 0 && j?.data?.plan) {
          claimed.push({ planId, plan: j.data.plan });
          continue; // 领到了继续试下一个缺失类型
        }
        if (j?.code === 1003) {
          dup.push({ planId, msg });
          continue; // 已领过：不阻断其它候选
        }
        // 1001 不存在 / 1005 超额等：试下一个候选
      }

      if (claimed.length) {
        return okResult('claimed', `已领取: ${claimed.map((c) => c.planId).join(', ')}`, {
          claimed: claimed.map((c) => c.planId),
          detail: { tried, claimedPlans: claimed.map((c) => c.plan) },
        });
      }
      if (dup.length) {
        // 缺失类型回 1003 → 上游领过但不在生效列表：一次性体验包已过期
        return okResult('already', `已领取过（体验窗口已结束，无法重复领取）: ${dup[0].planId}`, {
          detail: { tried, expired: dup.map((d) => d.planId) },
        });
      }
      return okResult('none', tried.at(-1)?.msg || '没有可领取的套餐', { detail: { tried } });
    } catch (e) {
      return failResult(e?.message || '领取失败');
    }
  }

  async function status(acc) {
    try {
      const [plans, balance] = await Promise.all([
        previewPlans(acc),
        get(acc, `/api/v1/zcode-plan/billing/balance?app_version=${appVersion}`),
      ]);
      const sec = now() / 1000;
      const active = (balance?.data?.plans ?? []).filter((p) => p.status === 'active' && (p.ends_at ?? 0) > sec);
      const kinds = new Set(active.map((p) => describePlan(p.plan_id, p.name)));
      const credits = (balance?.data?.balances ?? []).reduce((sum, b) => sum + (Number(b.remaining_units) || 0), 0);
      return {
        supported: true,
        checkedIn: kinds.has('daily') && kinds.has('promo'),
        claimable: plans.length > 0,
        credits,
        message: [...kinds].length ? `生效额度: ${[...kinds].join(', ')}` : '无生效额度',
        details: { activeKinds: [...kinds], activePlans: active.map((p) => ({ id: p.plan_id, name: p.name })), claimablePlans: plans },
      };
    } catch (e) {
      return { supported: false, checkedIn: false, claimable: false, credits: 0, message: e?.message || '查询失败' };
    }
  }

  return { name: 'zcode', run, status };
}
