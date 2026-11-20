// ZCode 福利领取（全量移植 ZCode-Daily v1.1.1 的领取链路：
// billing/preview + marketing/touch 双来源 → priority 择优 → 窗口判定 → claim →
// marketing confirm 回执。原 ZCode2api 的按 kind 补缺保留为无来源时的兜底。
// run() 绝不抛出；同一账号的调用由调用方串行化。

import { randomUUID } from 'node:crypto';
import { deviceIdFor, sessionIdFor } from '../../core/fingerprint.mjs';
import { ZCODE_ORIGIN, ZCODE_APP_VERSION, ZCODE_MARKETING_MIN_APP_VERSION } from './constants.mjs';

const DEFAULT_ORIGIN = ZCODE_ORIGIN;
const DEFAULT_APP_VERSION = ZCODE_APP_VERSION;
const CLAIM_TIMEOUT_MS = 15_000;
const BUDGET_MS = 25_000;
const ACTIVATION_EVENTS = ['app_launch', 'app_daily_active'];
const MARKETING_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const REQUEST_RETRIES = 3;
const RETRY_BACKOFF_MS = 1_500;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 把 plan_id / plan 名译成额度类型（活动包/每日体验/付费/夜间）。 */
export function describePlan(id, name) {
  const s = `${id || ''} ${name || ''}`.toUpperCase();
  if (s.includes('WEEKEND') || s.includes('-WK')) return 'promo';
  if (s.includes('OFF-PEAK') || s.includes('OFFPEAK')) return 'offpeak';
  if (s.includes('START-PLAN') || s.includes('START PLAN')) return 'daily';
  if (s.includes('CODING-PLAN') || s.includes('CODING PLAN')) return 'paid';
  return 'other';
}

// ---------- 套餐归一 / 合并 / 择优（对齐 ZCode-Daily 同名纯函数） ----------

const MAX_IDENTIFIER_LEN = 256;
const MAX_CAMPAIGN_IDS = 16;

/** 上游 id 类字段：去空白、拒绝超长与控制字符（防把响应里的脏值写进请求体）。 */
function identifierOf(value) {
  if (typeof value !== 'string') return '';
  const v = value.trim();
  if (!v || v.length > MAX_IDENTIFIER_LEN) return '';
  for (const ch of v) if (ch.charCodeAt(0) < 32) return '';
  return v;
}

/** 秒 / 毫秒都接受，统一归一到毫秒；非法归 null。 */
function msOf(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n < 1e12 ? n * 1000 : n;
}

function intOf(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

function entitlementsOf(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const e of raw) {
    if (!e || typeof e !== 'object') continue;
    const name = String(e.show_name ?? e.showName ?? e.name ?? '').trim();
    if (!name) continue;
    out.push({
      name,
      unit: String(e.unit_type ?? e.unitType ?? e.unit ?? ''),
      grant: Number(e.grant_units ?? e.grantUnits ?? e.grant ?? 0) || 0,
      period: String(e.period ?? ''),
    });
  }
  return out;
}

/**
 * 上游 plan 条目 → 网关内部 plan。
 * 时间统一毫秒；sources 记录来源（billing / marketing），campaignIds 供领取后发 confirm 回执。
 */
export function normalizePlan(raw, source, { defaultPriority = 0, campaignIds = [] } = {}) {
  if (!raw || typeof raw !== 'object') return null;
  const planId = identifierOf(raw.plan_id ?? raw.planId);
  if (!planId) return null;

  const campaigns = [];
  for (const c of campaignIds) {
    const id = identifierOf(c);
    if (id && !campaigns.includes(id)) campaigns.push(id);
    if (campaigns.length >= MAX_CAMPAIGN_IDS) break;
  }

  return {
    planId,
    name: String(raw.name ?? '').trim() || planId,
    description: String(raw.description ?? '').trim(),
    priority: intOf(raw.priority, defaultPriority),
    startsAt: msOf(raw.starts_at ?? raw.startsAt),
    endsAt: msOf(raw.ends_at ?? raw.endsAt),
    entitlements: entitlementsOf(raw.entitlements),
    sources: [source],
    campaignIds: campaigns,
  };
}

function mergeInto(existing, incoming) {
  if (!existing.name || existing.name === existing.planId) existing.name = incoming.name || existing.name;
  if (!existing.description) existing.description = incoming.description;
  existing.priority = Math.max(existing.priority, incoming.priority);
  if (existing.startsAt === null && incoming.startsAt !== null) existing.startsAt = incoming.startsAt;
  if (existing.endsAt === null && incoming.endsAt !== null) existing.endsAt = incoming.endsAt;
  if (!existing.entitlements.length && incoming.entitlements.length) existing.entitlements = incoming.entitlements.map((e) => ({ ...e }));
  for (const s of incoming.sources) if (!existing.sources.includes(s)) existing.sources.push(s);
  for (const c of incoming.campaignIds) {
    if (!existing.campaignIds.includes(c) && existing.campaignIds.length < MAX_CAMPAIGN_IDS) existing.campaignIds.push(c);
  }
}

/** 两来源按 planId 合并；保留首次出现顺序（同 priority 取先出现）。 */
export function mergePlans(...groups) {
  const out = [];
  const byId = new Map();
  for (const group of groups) {
    for (const plan of group ?? []) {
      if (!plan?.planId) continue;
      const copy = { ...plan, entitlements: (plan.entitlements ?? []).map((e) => ({ ...e })), sources: [...(plan.sources ?? [])], campaignIds: [...(plan.campaignIds ?? [])] };
      const existing = byId.get(copy.planId);
      if (existing) mergeInto(existing, copy);
      else {
        byId.set(copy.planId, copy);
        out.push(copy);
      }
    }
  }
  return out;
}

/** 上游 starts_at / ends_at 与本地时间判定活动窗口；缺字段视为不限。 */
export function planWindow(plan, nowMs) {
  if (plan?.startsAt !== null && plan?.startsAt !== undefined && nowMs < plan.startsAt) return 'future';
  if (plan?.endsAt !== null && plan?.endsAt !== undefined && nowMs >= plan.endsAt) return 'expired';
  return 'active';
}

/** priority 最高者获胜，同 priority 保留先出现的；wantedId 指定时只读它。 */
export function pickPlan(plans, wantedId = '') {
  const wanted = identifierOf(wantedId);
  if (wanted) return plans.find((p) => p.planId === wanted) ?? null;
  let best = null;
  for (const p of plans) if (!best || p.priority > best.priority) best = p;
  return best;
}

// ---------- marketing 第二来源解析 ----------

// 递归防护：活动内容由运营后台下发，嵌套深度与节点数都不可信。
const MARKETING_MAX_DEPTH = 12;
const MARKETING_MAX_NODES = 4096;
const MARKETING_MAX_DELIVERIES = 32;

/**
 * 单条 delivery 的内容树 → 套餐列表。
 * 只认 action.type === 'claim_zcode_plan' 的按钮，配套的 zcode_plan 元数据用于补名字/有效期。
 */
function walkDelivery(delivery) {
  const metadata = new Map();
  const actionIds = [];
  const seen = new Set();
  let budget = MARKETING_MAX_NODES;
  const deliveryPriority = intOf(delivery.priority, 0);

  const remember = (plan) => {
    if (!plan) return;
    const existing = metadata.get(plan.planId);
    if (existing) mergeInto(existing, plan);
    else metadata.set(plan.planId, plan);
  };

  const walk = (node, depth) => {
    if (depth > MARKETING_MAX_DEPTH || budget <= 0) return;
    if (!node || typeof node !== 'object') return;
    if (seen.has(node)) return;
    seen.add(node);
    budget -= 1;

    if (Array.isArray(node)) {
      for (const child of node) walk(child, depth + 1);
      return;
    }

    remember(normalizePlan(node, 'marketing', { defaultPriority: deliveryPriority }));
    if (node.zcode_plan && typeof node.zcode_plan === 'object') {
      remember(normalizePlan(node.zcode_plan, 'marketing', { defaultPriority: deliveryPriority }));
    }
    const action = node.action;
    if (action && typeof action === 'object' && action.type === 'claim_zcode_plan') {
      const planId = identifierOf(action.args?.plan_id);
      if (planId && !actionIds.includes(planId)) actionIds.push(planId);
    }
    for (const value of Object.values(node)) walk(value, depth + 1);
  };

  walk(delivery, 0);

  const campaignId = identifierOf(delivery.campaign_id);
  const out = [];
  for (const planId of actionIds) {
    let plan = metadata.get(planId);
    if (plan) {
      plan = { ...plan, entitlements: plan.entitlements.map((e) => ({ ...e })), sources: [...plan.sources], campaignIds: [...plan.campaignIds] };
    } else {
      // 只有按钮没有元数据：照样可领，名字先用 id 顶上
      plan = { planId, name: planId, description: '', priority: deliveryPriority, startsAt: null, endsAt: null, entitlements: [], sources: ['marketing'], campaignIds: [] };
    }
    if (campaignId && !plan.campaignIds.includes(campaignId) && plan.campaignIds.length < MAX_CAMPAIGN_IDS) {
      plan.campaignIds.push(campaignId);
    }
    out.push(plan);
  }
  return out;
}

/** GET /api/v1/marketing/touch 响应 → { plans, error }；结构异常时 error 非空且 plans 为空。 */
export function parseMarketingPlans(payload) {
  const deliveries = payload?.data?.deliveries;
  if (!Array.isArray(deliveries)) return { plans: [], error: '营销套餐查询失败：上游未返回有效活动列表' };
  if (deliveries.length > MARKETING_MAX_DELIVERIES) {
    return { plans: [], error: `营销套餐查询失败：活动列表超过上限 ${MARKETING_MAX_DELIVERIES}` };
  }
  const plans = [];
  for (const delivery of deliveries) {
    if (delivery && typeof delivery === 'object') plans.push(...walkDelivery(delivery));
  }
  return { plans: mergePlans(plans), error: '' };
}

// ---------- 激活事件上报 ----------

/**
 * 领取资格的前置动作：官方客户端启动 / 日活会向事件接口报 app_launch 与 app_daily_active，
 * 运营系统据此发放资格，套餐探测才列得出来。纯脚本走不到那条链路，所以领取前主动补报一次。
 */
export function activationEventBody(event, { userId, deviceId, appVersion, eventId }) {
  return {
    event_id: eventId,
    client_timezone: 'Asia/Shanghai',
    client_language: 'zh-CN',
    element_name: event,
    event_region: 'app',
    event_type: 'view',
    event_text: '',
    event_extra_detail: {},
    user_id: userId,
    screen_resolution: '2560x1440',
    app_version: appVersion,
    device_os_category: 'windows',
    device_os_version: '10.0.22631',
    device_mid: deviceId,
    source_page: '',
    source_element: '{}',
  };
}

/** 补报激活事件；失败只返回 ok:false，绝不抛出（不能阻断领取）。 */
export async function reportActivation(acc, { fetchImpl = fetch, origin = DEFAULT_ORIGIN, appVersion = DEFAULT_APP_VERSION, timeoutMs = CLAIM_TIMEOUT_MS } = {}) {
  const userId = String(acc?.uid ?? '');
  if (!userId) return { ok: false, message: '缺少用户标识，跳过激活事件上报' };
  const deviceId = acc?.deviceId || deviceIdFor(acc.uid);
  const errors = [];
  for (const event of ACTIVATION_EVENTS) {
    try {
      const res = await fetchImpl(`${origin}/api/v1/event/report`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(activationEventBody(event, { userId, deviceId, appVersion, eventId: randomUUID() })),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = await res.text();
      let env = null;
      try {
        env = JSON.parse(text);
      } catch {
        env = null;
      }
      if (!res.ok || env?.code !== 0) errors.push(`${event}: HTTP ${res.status} code=${env?.code}`);
    } catch (e) {
      errors.push(`${event}: ${e?.message || e}`);
    }
  }
  return errors.length ? { ok: false, message: errors.join('；') } : { ok: true, message: 'ok' };
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
/** 当天不必再试的失败（凭证失效、验证码）：调度器据此在窗口内放弃该账号。 */
const terminalResult = (message, extra = {}) => failResult(message, { ...extra, detail: { retryable: false, ...(extra.detail || {}) } });

/** 业务错误码 → 中文说明（对齐 ZCode-Daily FAILURE_LABELS）。 */
const FAILURE_LABELS = {
  1001: '没有这个套餐',
  1002: '活动还没开始或已经结束',
  1003: '该账号已经领过这一期',
  1004: '当前账号或客户端版本不在活动范围内',
  1005: '今天领取次数或者名额已经用完',
  3001: '请求参数不对（重点检查 device-mid）',
  3007: '验证码没通过，需要补充抓到的验证码参数',
  401: '登录状态失效，重新登录一下吧',
};

/** 北京时间（UTC+8 固定偏移）'YYYY-MM-DD HH:mm'，不依赖宿主机时区。 */
function formatBeijing(ms) {
  if (!ms) return '立即';
  const d = new Date(Number(ms) + 8 * 3_600_000);
  return `${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 16)}`;
}

/** a.b.c 形式版本比较；解析失败返回 null。 */
function versionTuple(value) {
  const parts = String(value ?? '').trim().toLowerCase().replace(/^v/, '').split('-')[0].split('.');
  if (!parts[0]) return null;
  const nums = [];
  for (const p of parts.slice(0, 3)) {
    const n = Number(p);
    if (!Number.isInteger(n)) return null;
    nums.push(n);
  }
  while (nums.length < 3) nums.push(0);
  return nums;
}

function versionAtLeast(value, minimum) {
  const a = versionTuple(value);
  const b = versionTuple(minimum);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return true;
}

function describePlanText(plan) {
  let text = plan.name;
  if (plan.entitlements?.length) {
    text += `：${plan.entitlements.map((e) => `${e.name} ${e.grant}${e.unit}（${e.period === 'daily' ? '每日' : '一次性'}）`).join('，')}`;
  }
  return text;
}

export function createClaimer({
  fetchImpl = fetch,
  now = Date.now,
  origin = DEFAULT_ORIGIN,
  appVersion = DEFAULT_APP_VERSION,
  budgetMs = BUDGET_MS,
  timeoutMs = CLAIM_TIMEOUT_MS,
  activation = true,
  marketingRecheck = true,
} = {}) {
  /**
   * GET 一条 JSON；HTTP 非 2xx 也返回 body（业务码在 body 里），网络错误才抛。
   * 429/5xx 与网络抖动按 1.5s×(n+1) 退避重试——上游对我方多账号并发很敏感，
   * 实测偶发 429，单次失败不应该让整个来源判死。
   */
  async function get(acc, path, headers = claimHeaders(acc, appVersion), maxBytes = 0) {
    let lastErr = null;
    for (let attempt = 0; attempt < REQUEST_RETRIES; attempt++) {
      if (attempt > 0) await sleep(RETRY_BACKOFF_MS * attempt);
      try {
        const res = await fetchImpl(`${origin}${path}`, {
          headers,
          signal: AbortSignal.timeout(timeoutMs),
        });
        const text = await res.text();
        if (maxBytes && Buffer.byteLength(text, 'utf8') > maxBytes) {
          throw Object.assign(new Error('响应超过大小上限'), { tooLarge: true });
        }
        let json;
        try {
          json = JSON.parse(text);
        } catch {
          // 429 等限流页返回非 JSON：可重试，别当成终态
          if (res.status === 429 || res.status >= 500) {
            lastErr = new Error(`HTTP ${res.status}`);
            continue;
          }
          throw new Error(`HTTP ${res.status} 响应不是合法 JSON`);
        }
        if ((res.status === 429 || res.status >= 500) && attempt + 1 < REQUEST_RETRIES) {
          lastErr = new Error(`HTTP ${res.status}`);
          continue;
        }
        return { status: res.status, json };
      } catch (e) {
        if (e?.tooLarge) throw e;
        lastErr = e;
      }
    }
    throw lastErr ?? new Error('请求失败');
  }

  // ---------- 来源 A：billing preview ----------

  async function billingSource(acc) {
    try {
      const { status, json } = await get(acc, `/api/v1/zcode-plan/billing/preview?app_version=${appVersion}&platform=win32-x64`);
      if (status === 404) return { ok: false, plans: [], error: '领取接口尚未部署（活动未上线）' };
      if (status === 401) return { ok: false, plans: [], error: '登录状态失效，重新登录一下吧', retryable: false };
      const code = json?.code;
      if (status !== 200 || (code != null && code !== 0)) {
        return { ok: false, plans: [], error: `套餐预览查询失败: ${json?.msg || json?.message || `HTTP ${status}`}` };
      }
      const plans = [];
      for (const raw of Array.isArray(json?.data?.plans) ? json.data.plans : []) {
        const plan = normalizePlan(raw, 'billing');
        if (plan) plans.push(plan);
      }
      return { ok: true, plans, error: '' };
    } catch (e) {
      return { ok: false, plans: [], error: `套餐预览请求失败: ${e?.message || e}` };
    }
  }

  // ---------- 来源 B：marketing touch ----------

  async function marketingSource(acc) {
    if (!versionAtLeast(appVersion, ZCODE_MARKETING_MIN_APP_VERSION)) {
      return { ok: false, plans: [], skipped: true, deployed: true, error: `营销套餐查询跳过：版本 ${appVersion} 低于 ${ZCODE_MARKETING_MIN_APP_VERSION}` };
    }
    try {
      const { status, json } = await get(
        acc,
        '/api/v1/marketing/touch?seq=0',
        {
          accept: 'application/json',
          'x-client-language': 'zh-CN',
          'x-zcode-app-version': appVersion,
          authorization: `Bearer ${acc.jwt}`,
          'x-device-mid': acc.deviceId || deviceIdFor(acc.uid),
        },
        MARKETING_MAX_RESPONSE_BYTES,
      );
      if (status === 404) return { ok: true, plans: [], deployed: false, error: '', deliveryCount: 0 };
      if (status !== 200 || json?.code !== 0 || json?.success === false) {
        return { ok: false, plans: [], error: `营销套餐查询失败: ${json?.msg || json?.message || `HTTP ${status}`}` };
      }
      const { plans, error } = parseMarketingPlans(json);
      if (error) return { ok: false, plans: [], error };
      const deliveries = Array.isArray(json?.data?.deliveries) ? json.data.deliveries : [];
      return { ok: true, plans, deployed: true, error: '', deliveryCount: deliveries.length };
    } catch (e) {
      return { ok: false, plans: [], error: e?.tooLarge ? '营销套餐查询失败：响应超过大小上限' : `营销套餐查询失败: ${e?.message || e}` };
    }
  }

  /** 两来源各自独立；单源失败不在 message 之外影响另一源。 */
  function sourceWarning(billing, marketing) {
    const failures = [];
    const skipped = [];
    if (!billing.ok) failures.push(`billing: ${billing.error || '未知错误'}`);
    if (!marketing.ok) {
      (marketing.skipped ? skipped : failures).push(`marketing: ${marketing.error || '未知错误'}`);
    }
    const parts = [];
    if (failures.length) parts.push(`部分来源失败: ${failures.join('；')}`);
    if (skipped.length) parts.push(`来源未查询: ${skipped.join('；')}`);
    return parts.length ? `；${parts.join('；')}` : '';
  }

  // ---------- 领取与回执 ----------

  async function claimOne(acc, planId) {
    const headers = { ...claimHeaders(acc, appVersion), 'content-type': 'application/json', 'x-platform': 'win32-x64' };
    if (acc.captcha) headers['x-aliyun-captcha-verify-param'] = String(acc.captcha);
    const res = await fetchImpl(`${origin}/api/v1/zcode-plan/billing/claim`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ plan_id: planId }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    try {
      return { status: res.status, json: JSON.parse(text) };
    } catch {
      return { status: res.status, json: { code: -1, msg: `HTTP ${res.status} ${text.slice(0, 80) || '(空响应)'}` } };
    }
  }

  /** marketing 来源的套餐领到后回执；失败只记日志，不改判已成功的领取。 */
  async function confirmMarketing(acc, plan) {
    if (!plan.campaignIds?.length) return '';
    const errors = [];
    let confirmed = 0;
    for (const campaignId of plan.campaignIds) {
      try {
        const res = await fetchImpl(`${origin}/api/v1/marketing/touch/action`, {
          method: 'POST',
          headers: {
            accept: 'application/json',
            'content-type': 'application/json',
            'x-client-language': 'zh-CN',
            'x-zcode-app-version': appVersion,
            authorization: `Bearer ${acc.jwt}`,
            'x-device-mid': acc.deviceId || deviceIdFor(acc.uid),
          },
          body: JSON.stringify({ campaign_id: campaignId, action_type: 'confirm' }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        const text = await res.text();
        let json = null;
        try {
          json = JSON.parse(text);
        } catch {
          json = null;
        }
        if (res.status >= 200 && res.status < 300 && json?.code === 0 && json?.success !== false) confirmed += 1;
        else errors.push(`${campaignId}: ${json?.msg || json?.message || `HTTP ${res.status}`}`);
      } catch (e) {
        errors.push(`${campaignId}: ${e?.message || e}`);
      }
    }
    if (!errors.length) return `；营销回执已确认（${confirmed} 个 campaign）`;
    if (confirmed) return `；营销回执部分成功（${confirmed}/${plan.campaignIds.length}）: ${errors.join('；')}（不影响已确认领取）`;
    return `；营销回执失败: ${errors.join('；')}（不影响已确认领取）`;
  }

  /** 领取后复查活动位：下线是正向证据，仍在也不算失败。 */
  async function recheckMarketing(acc, plan) {
    if (!marketingRecheck || !plan.campaignIds?.length) return '';
    const again = await marketingSource(acc);
    if (!again.ok) return `；营销复查询失败: ${again.error}`;
    if (!again.deployed) return '；营销复查询接口未部署，不能作为活动位下线证据';
    if (again.deliveryCount === 0) return '；营销活动位已下线（正向证据）';
    if (again.plans.some((p) => p.planId === plan.planId)) return '；营销活动位仍返回该套餐（不作为失败）';
    return `；营销活动位仍有活动但未匹配到该套餐（不作为下线证据）`;
  }

  async function finalizeMarketing(acc, plan) {
    if (!plan.campaignIds?.length) return '';
    return (await confirmMarketing(acc, plan)) + (await recheckMarketing(acc, plan));
  }

  // ---------- 兜底：上游两源都没给候选时的按日期编码活动包 ----------

  async function run(acc, { force = false } = {}) {
    try {
      const nowMs = now();
      const stamp = beijingStamps(now());
      // 兜底候选：活动包 id 的日期编码两种形态都出现过——
      // 旧版参考 zcode-v3-start-plan-1120-wk，2026-11 线上实际返回 zcode-v3-start-plan-wk-1120。
      // 只试今天与昨天，避免把早已结束的期数再打一遍。
      const fallbackIds = stamp
        .slice(0, 2)
        .flatMap((s) => [`zcode-v3-start-plan-wk-${s}`, `zcode-v3-start-plan-${s}-wk`]);

      const activationNote = activation ? await reportActivation(acc, { fetchImpl, origin, appVersion, timeoutMs }) : { ok: false, message: 'dispatcher 已关闭' };

      const [billing, marketing] = await Promise.all([billingSource(acc), marketingSource(acc)]);
      const warning = sourceWarning(billing, marketing);

      const plans = mergePlans(billing.plans, marketing.plans);
      const wantedId = process.env.ZCODE_PLAN_ID || '';

      if (!plans.length) {
        // 凭证/验证码类失败优先：源挂了就不该退回日期兜底去撞
        if (billing.retryable === false || marketing.retryable === false) {
          return terminalResult(`套餐来源查询未完成${warning}`, { detail: { billing, marketing } });
        }
        // 两源都正常但都没有可领套餐：服务端现状就是空，中性结论，不打上游。
        // 只有 billing 本身也有问题（如接口未部署）时，才退回按日期编码的兜底尝试。
        if (billing.ok) {
          return okResult('none', `当前无新套餐（billing / marketing 均未返回可领套餐）${warning}`, {
            detail: { billing, marketing, activation: activationNote.message },
          });
        }
        const tried = [];
        const dupIds = [];
        const deadline = nowMs + budgetMs;
        for (const planId of fallbackIds) {
          if (now() > deadline) {
            tried.push({ planId: '(...)', code: 'budget', msg: '候选太多，已超时中止' });
            break;
          }
          const { status, json } = await claimOne(acc, planId);
          const msg = json?.data?.message || json?.msg || '';
          tried.push({ planId, code: json?.code, msg });
          if (status === 200 && json?.code === 0 && json?.data?.plan) {
            return okResult('claimed', `领取成功: ${planId}（${formatBeijing(now())}）${warning}`, {
              claimed: [planId],
              detail: { tried, source: 'fallback', activation: activationNote.message },
            });
          }
          // 1003 = 这一期确实存在但已领过；记下来继续试另一种 id 形态（1001 不存在同样继续）
          if (json?.code === 1003) dupIds.push(planId);
        }
        if (dupIds.length) {
          return okResult('already', `今日已领取: ${dupIds[0]}${warning}`, {
            detail: { tried, source: 'fallback', duplicateOf: dupIds, activation: activationNote.message },
          });
        }
        return okResult('none', `当前无新套餐（billing / marketing 均未返回可领套餐）${warning}`, {
          detail: { tried, billing, marketing, activation: activationNote.message },
        });
      }

      const target = pickPlan(plans, wantedId);
      if (!target) {
        return failResult(`指定的 ZCODE_PLAN_ID 不在可领列表里${warning}`, { detail: { billing, marketing } });
      }

      // 窗口判定（上游 starts_at / ends_at）
      const future = [];
      for (const p of plans) if (planWindow(p, now()) === 'future') future.push(p);
      const activePlans = plans.filter((p) => planWindow(p, now()) === 'active');
      if (!activePlans.length) {
        if (future.length) {
          const next = future.reduce((a, b) => (b.startsAt < a.startsAt ? b : a));
          return failResult(`${wantedId ? '目标' : '最近'}活动窗口未开启: ${next.name}（北京时间 ${formatBeijing(next.startsAt)} 开启）${warning}`, {
            detail: { billing, marketing, future: future.map((p) => p.planId) },
          });
        }
        const expired = plans.reduce((a, b) => ((b.endsAt ?? 0) > (a.endsAt ?? 0) ? b : a));
        return failResult(`活动已结束: ${expired.name}（北京时间 ${formatBeijing(expired.endsAt)} 结束）${warning}`, {
          detail: { billing, marketing },
        });
      }

      const effectiveTarget = activePlans.includes(target) ? target : pickPlan(activePlans, wantedId);
      if (!effectiveTarget) {
        const next = future.reduce((a, b) => (b.startsAt < a.startsAt ? b : a), future[0]);
        return failResult(`目标套餐未开窗（北京时间 ${formatBeijing(next?.startsAt)} 开启）${warning}`, { detail: { billing, marketing } });
      }

      const order = wantedId ? [effectiveTarget] : [effectiveTarget, ...activePlans.filter((p) => p !== effectiveTarget)];
      const tried = [];
      const claimedPlans = [];
      const dups = [];
      const deadline = now() + budgetMs;
      let lastCode = null;
      let lastMsg = '';

      for (const plan of order) {
        if (now() > deadline) break;
        const { status, json } = await claimOne(acc, plan.planId);
        const msg = json?.data?.message || json?.msg || '';
        const code = json?.code;
        lastCode = code;
        lastMsg = msg;
        tried.push({ planId: plan.planId, code, msg });
        if (status === 200 && code === 0 && json?.data?.plan) {
          claimedPlans.push(plan);
          // 营销来源的套餐要回执 campaign，确认活动位消费掉
          const note = await finalizeMarketing(acc, plan);
          return okResult('claimed', `领取成功: ${describePlanText(plan)}（${formatBeijing(now())}）${note}${warning}`, {
            claimed: claimedPlans.map((p) => p.planId),
            detail: { tried, sources: plan.sources, activation: activationNote.message },
          });
        }
        if (code === 1003) {
          dups.push(plan);
          if (!wantedId) break; // 幂等：今天已领过就不再试别的
          continue;
        }
        if (code === 3007 || code === 3001 || code === 401) break; // 需要人干预，换套餐也没用
        // 1001 不存在 / 1005 超额：继续试下一个候选
      }

      if (dups.length) {
        const plan = dups[0];
        const note = await finalizeMarketing(acc, plan);
        return okResult('already', `该账号已领取过这一期: ${plan.name}${note}${warning}`, {
          detail: { tried, sources: plan.sources, activation: activationNote.message },
        });
      }

      const label = FAILURE_LABELS[lastCode] || lastMsg || '领取失败';
      let message = `领取未成功: ${label}（code=${lastCode}）`;
      if (lastCode === 3007 && !acc.captcha) message += '；从浏览器抓一次 claim 请求，把 X-Aliyun-Captcha-Verify-Param 填到账号的 captcha 字段';
      if (lastCode === 3001) message += '；检查 device-mid 与客户端版本；若带验证码，确认参数未过期';
      message += warning;
      const terminal = lastCode === 3007 || lastCode === 3001 || lastCode === 401;
      return terminal
        ? terminalResult(message, { detail: { tried, activation: activationNote.message } })
        : failResult(message, { detail: { tried, activation: activationNote.message } });
    } catch (e) {
      return failResult(e?.message || '领取失败');
    }
  }

  /** 当前生效中的 grant（promo 等非日包在效即算已领）。 */
  async function activeGrants(acc) {
    try {
      const { json } = await get(acc, `/api/v1/zcode-plan/billing/balance?app_version=${appVersion}`);
      const sec = now() / 1000;
      return (json?.data?.plans ?? []).filter((p) => p.status === 'active' && (p.ends_at ?? 0) > sec);
    } catch {
      return [];
    }
  }

  async function status(acc) {
    try {
      const [billingR, marketingR, balanceR] = await Promise.allSettled([
        billingSource(acc),
        marketingSource(acc),
        get(acc, `/api/v1/zcode-plan/billing/balance?app_version=${appVersion}`),
      ]);
      const billing = billingR.status === 'fulfilled' ? billingR.value : { ok: false, plans: [], error: String(billingR.reason) };
      const marketing = marketingR.status === 'fulfilled' ? marketingR.value : { ok: false, plans: [], error: String(marketingR.reason) };
      const balance = balanceR.status === 'fulfilled' ? balanceR.value.json : {};

      const sec = now() / 1000;
      const active = (balance?.data?.plans ?? []).filter((p) => p.status === 'active' && (p.ends_at ?? 0) > sec);
      const kinds = new Set(active.map((p) => describePlan(p.plan_id, p.name)));
      const credits = (balance?.data?.balances ?? []).reduce((sum, b) => sum + (Number(b.remaining_units) || 0), 0);
      const claimablePlans = mergePlans(billing.plans, marketing.plans).filter((p) => planWindow(p, now()) === 'active');
      const sourceErrors = [];
      for (const [label, r] of [['billing', billing], ['marketing', marketing]]) {
        if (r && r.ok === false) sourceErrors.push(`${label}: ${r.error || '未知错误'}`);
      }

      return {
        supported: true,
        checkedIn: kinds.has('daily') && kinds.has('promo'),
        claimable: claimablePlans.length > 0,
        credits,
        message: kinds.size ? `生效额度: ${[...kinds].join(', ')}` : '无生效额度',
        details: {
          activeKinds: [...kinds],
          activePlans: active.map((p) => ({ id: p.plan_id, name: p.name })),
          claimablePlans: claimablePlans.map((p) => ({ planId: p.planId, name: p.name, sources: p.sources })),
          ...(sourceErrors.length ? { sourceErrors } : {}),
        },
      };
    } catch (e) {
      return { supported: false, checkedIn: false, claimable: false, credits: 0, message: e?.message || '查询失败' };
    }
  }

  return { name: 'zcode', run, status };
}
