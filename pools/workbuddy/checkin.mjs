// WorkBuddy 签到/福利领取。cn（codebuddy.cn / copilot.tencent.com 双宿主，
// 成功即记忆）走每日签到；global（workbuddy.ai）只有一次性 IDE 试用领取，
// 无每日签到。另有 web 端补偿/礼包活动领取（X-Client-Platform: web）。
// 端点串本地定义：constants.mjs 正在被并行改动，避免 import 冲突（EP_CHECKIN_STATUS 除外）。
// run() 绝不抛出；同一账号的调用由调用方串行化。

import { EP_CHECKIN_STATUS } from './constants.mjs';
import { authHeaders } from './headers.mjs';

const EP_DAILY_CHECKIN = '/v2/billing/meter/daily-checkin';
const EP_IDE_TRIAL = '/billing/ide/trial';
const EP_COMPENSATION_STATUS = '/billing/meter/compensation-status';
const EP_CLAIM_COMPENSATION = '/billing/meter/claim-compensation';
const EP_CHECK_GIFT = '/billing/meter/check-gift-claimed';
const EP_CLAIM_GIFT = '/billing/meter/claim-gift';

const CN_HOSTS_DEFAULT = ['https://www.codebuddy.cn', 'https://copilot.tencent.com'];
const GLOBAL_BASE_DEFAULT = 'https://www.workbuddy.ai';
const TIMEOUT_MS = 15_000;

const okResult = (status, message, extra = {}) => ({ ok: true, status, claimed: [], credits: 0, message, ...extra });
const failResult = (message, extra = {}) => ({ ok: false, status: 'failed', claimed: [], credits: 0, message, ...extra });

const realmOf = (acc) => String(acc?.realm || acc?.region || 'cn').toLowerCase();

async function postJson({ fetchImpl, url, acc, body = {}, extraHeaders, timeoutMs }) {
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { ...authHeaders(acc, { endpoint: url }), 'Content-Type': 'application/json', Accept: 'application/json', ...extraHeaders },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { httpStatus: res.status, json };
}

const bizCode = (j) => Number(j?.code);
const bizMsg = (j) => String(j?.message ?? j?.msg ?? '');

/** checkin-activity-status 的 data 归一（字段名两套实测都出现过）。 */
function parseCheckinStatus(json) {
  const d = json?.data ?? {};
  return {
    active: d.active !== false,
    checkedIn: Boolean(d.today_checked_in || d.checked_in),
    streakDays: Number(d.streak_days) || 0,
    dailyCredit: Number(d.daily_credit ?? d.today_credit ?? d.credits) || 0,
  };
}

/**
 * web 端补偿/礼包活动领取（best-effort）：只在 active && !claimed 时发起 claim。
 * 返回逐项结果数组，单失败不抛出。
 */
export async function claimWbWebActivities(acc, { fetchImpl = fetch, now = Date.now, endpoint, timeoutMs = TIMEOUT_MS } = {}) {
  const call = (path, body = {}) =>
    postJson({ fetchImpl, url: `${endpoint}${path}`, acc, body, extraHeaders: { 'X-Client-Platform': 'web' }, timeoutMs });
  const out = [];

  // 补偿（compensation）
  try {
    const s = await call(EP_COMPENSATION_STATUS);
    const d = s.json?.data ?? {};
    if (s.httpStatus === 404) {
      out.push({ kind: 'compensation', ok: true, status: 'none', credits: 0, message: '无此活动' });
    } else if (d.active && !d.claimed) {
      const c = await call(EP_CLAIM_COMPENSATION);
      const claimed = bizCode(c.json) === 0;
      out.push({
        kind: 'compensation',
        ok: claimed,
        status: claimed ? 'claimed' : 'failed',
        credits: claimed ? Number(c.json?.data?.credits ?? c.json?.data?.credit ?? 0) || 0 : 0,
        message: claimed ? '补偿已领取' : bizMsg(c.json) || '补偿领取失败',
      });
    } else {
      out.push({ kind: 'compensation', ok: true, status: d.claimed ? 'already' : 'none', credits: 0, message: d.claimed ? '补偿已领取' : '补偿未激活' });
    }
  } catch (e) {
    out.push({ kind: 'compensation', ok: false, status: 'failed', credits: 0, message: e?.message || '查询失败' });
  }

  // 礼包（gift）
  try {
    const s = await call(EP_CHECK_GIFT);
    const d = s.json?.data ?? {};
    if (s.httpStatus === 404) {
      out.push({ kind: 'gift', ok: true, status: 'none', credits: 0, message: '无此活动' });
    } else if (d.active !== false && !d.claimed) {
      const c = await call(EP_CLAIM_GIFT);
      const claimed = bizCode(c.json) === 0;
      out.push({
        kind: 'gift',
        ok: claimed,
        status: claimed ? 'claimed' : 'failed',
        credits: claimed ? Number(c.json?.data?.credits ?? c.json?.data?.credit ?? 0) || 0 : 0,
        message: claimed ? '礼包已领取' : bizMsg(c.json) || '礼包领取失败',
      });
    } else {
      out.push({ kind: 'gift', ok: true, status: d.claimed ? 'already' : 'none', credits: 0, message: d.claimed ? '礼包已领取' : '礼包未激活' });
    }
  } catch (e) {
    out.push({ kind: 'gift', ok: false, status: 'failed', credits: 0, message: e?.message || '查询失败' });
  }

  return out;
}

export function createClaimer({
  fetchImpl = fetch,
  now = Date.now,
  cnHosts = CN_HOSTS_DEFAULT,
  globalBase = GLOBAL_BASE_DEFAULT,
  name = 'workbuddy-cn',
  webActivities = true,
  timeoutMs = TIMEOUT_MS,
} = {}) {
  let cnHost = null; // 成功宿主记忆

  async function tryHost(host, fn) {
    try {
      return await fn(host);
    } catch (e) {
      return { __fallback: true, __error: e?.message || String(e) };
    }
  }

  async function run(acc, { force = false } = {}) {
    try {
      if (realmOf(acc) === 'global') {
        const { httpStatus, json } = await postJson({ fetchImpl, url: `${globalBase}${EP_IDE_TRIAL}`, acc, timeoutMs });
        if (httpStatus === 404) {
          return { ok: true, status: 'unsupported', claimed: [], credits: 0, message: '国际版无每日签到' };
        }
        const msg = bizMsg(json);
        if (bizCode(json) === 0) {
          return okResult('claimed', 'IDE 试用已领取', { claimed: ['ide-trial'], credits: Number(json?.data?.credits) || 0 });
        }
        if (/14051|已领取|already/.test(msg)) {
          return okResult('already', 'IDE 试用已领取过');
        }
        return failResult(msg || `试用领取失败 (code=${bizCode(json)})`);
      }

      // cn：双宿主探测，404/网络错误换下一个；成功宿主记忆
      const hosts = cnHost ? [cnHost, ...cnHosts.filter((h) => h !== cnHost)] : cnHosts;
      let usedHost = null;
      let st = null;
      let lastError = '';
      for (const host of hosts) {
        const r = await tryHost(host, async (h) => postJson({ fetchImpl, url: `${h}${EP_CHECKIN_STATUS}`, acc, timeoutMs }));
        if (r.__fallback) {
          lastError = r.__error;
          continue;
        }
        if (r.httpStatus === 404) {
          lastError = `${host} 签到接口 404`;
          continue;
        }
        usedHost = host;
        st = parseCheckinStatus(r.json);
        break;
      }
      if (!usedHost) {
        return failResult(lastError || '所有签到主机不可达');
      }
      cnHost = usedHost;

      if (!st.active) {
        return okResult('none', '签到活动未激活', { detail: st });
      }
      if (st.checkedIn && !force) {
        return okResult('already', '今日已签到', { credits: st.dailyCredit });
      }

      const r = await postJson({ fetchImpl, url: `${usedHost}${EP_DAILY_CHECKIN}`, acc, timeoutMs });
      const code = bizCode(r.json);
      const msg = bizMsg(r.json);
      if (r.httpStatus === 400 && (code === 10001 || /已签|already|repeat/.test(msg))) {
        return okResult('already', '今日已签到', { credits: st.dailyCredit });
      }
      if (r.httpStatus === 404) {
        return failResult(`${usedHost} 签到接口 404`);
      }
      if (code !== 0) {
        return failResult(msg || `签到失败 (code=${code})`);
      }

      const credits = Number(r.json?.data?.credits ?? r.json?.data?.daily_credit ?? st.dailyCredit) || 0;
      const result = okResult('claimed', `签到成功${credits ? `（+${credits}）` : ''}`, { claimed: ['checkin'], credits });

      // web 端活动 best-effort，失败不影响签到结果
      if (webActivities !== false) {
        const acts = await claimWbWebActivities(acc, { fetchImpl, now, endpoint: usedHost, timeoutMs }).catch(() => []);
        const extra = acts.filter((a) => a.status === 'claimed');
        result.claimed.push(...extra.map((a) => a.kind));
        result.credits += extra.reduce((sum, a) => sum + a.credits, 0);
        result.detail = { webActivities: acts };
      }
      return result;
    } catch (e) {
      return failResult(e?.message || '签到失败');
    }
  }

  async function status(acc) {
    if (realmOf(acc) === 'global') {
      return { supported: false, checkedIn: false, claimable: false, credits: 0, message: '国际版无每日签到' };
    }
    const hosts = cnHost ? [cnHost, ...cnHosts.filter((h) => h !== cnHost)] : cnHosts;
    let lastError = '';
    for (const host of hosts) {
      const r = await tryHost(host, async (h) => postJson({ fetchImpl, url: `${h}${EP_CHECKIN_STATUS}`, acc, timeoutMs }));
      if (r.__fallback) {
        lastError = r.__error;
        continue;
      }
      if (r.httpStatus === 404) {
        lastError = `${host} 签到接口 404`;
        continue;
      }
      const st = parseCheckinStatus(r.json);
      return {
        supported: true,
        checkedIn: st.checkedIn,
        claimable: st.active && !st.checkedIn,
        credits: st.dailyCredit,
        message: st.checkedIn ? '今日已签到' : st.active ? '今日未签到' : '签到活动未激活',
        details: { host, streakDays: st.streakDays, active: st.active },
      };
    }
    return { supported: false, checkedIn: false, claimable: false, credits: 0, message: lastError || '所有签到主机不可达' };
  }

  return { name, run, status };
}
