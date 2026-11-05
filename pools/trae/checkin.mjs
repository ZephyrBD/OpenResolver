// Trae SOLO 每日签到（移植自 vendor/cpa-trae/trae/upstream/client.go :553-956，MIT）。
// 关键语义：
// - POST /trae/api/v2/ug/checkin_credits/{status,claim}，body 走 req_source 探测序列
//   （solo 谱系 2→1→{}，cn 谱系 1→{}→2），鉴权双方案 Cloud-IDE-JWT→Bearer；
//   9074（活动校验拒绝）同 body 换 scheme 无意义 → 跳 scheme 换 body。
// - X-Device-Id 每次请求全新 16 位随机数字串（device_id 复用是 9074 可疑诱因）。
// - claim code:0 不是成功证据：当日已签账号任何 device_id 的 claim 都幂等回 0
//   （假成功陷阱），必须回查 status.checked_in 翻转才算到账。
// - credits 与 extra_credits 是同一份奖励的两种表述，取其一永不相加。
// run() 绝不抛出；同一账号的调用由调用方串行化。

import crypto from 'node:crypto';
import { DEFAULT_BIZ_HOST, EP_CHECKIN_STATUS, EP_CHECKIN_CLAIM } from './constants.mjs';
import { ugHeaders } from './headers.mjs';

const TIMEOUT_MS = 15_000;
const SCHEMES = ['Cloud-IDE-JWT', 'Bearer'];

const okResult = (status, message, extra = {}) => ({ ok: true, status, claimed: [], credits: 0, message, ...extra });
const failResult = (message, extra = {}) => ({ ok: false, status: 'failed', claimed: [], credits: 0, message, ...extra });

/** req_source 探测序列（client.go ugCheckinReqSourcesFor :644-657）。 */
export function bodiesFor(variant) {
  return String(variant || '').toLowerCase() === 'solo'
    ? [{ req_source: 2 }, { req_source: 1 }, {}]
    : [{ req_source: 1 }, {}, { req_source: 2 }];
}

const bodyLabel = (body) => (body.req_source === 1 ? 'req_source=1' : body.req_source === 2 ? 'req_source=2' : 'empty');

/** NewCheckinDeviceID（client.go :707-715）：16 位随机数字串，每次不同。 */
export function newCheckinDeviceId() {
  const n = BigInt(`0x${crypto.randomBytes(8).toString('hex')}`) % 10n ** 16n;
  return String(n).padStart(16, '0');
}

async function ugOnce({ url, body, scheme, acc, fetchImpl, timeoutMs }) {
  const headers = ugHeaders(acc, { scheme });
  headers['X-Device-Id'] = newCheckinDeviceId();
  const res = await fetchImpl(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`HTTP ${res.status} 响应不是合法 JSON`);
  }
  return json;
}

/**
 * body×scheme 探测循环（client.go CheckinStatus/CheckinClaim）。
 * code 0 → 返回该响应；9074 → 跳出 scheme 换 body；其它码继续下一 scheme。
 * 全部被拒 → 抛错（run 捕获转 failed）；网络层错误原样上抛。
 */
async function ugProbe({ url, acc, fetchImpl, timeoutMs }) {
  const attempted = [];
  let lastMsg = '';
  let lastCode;
  for (const body of bodiesFor(acc.variant)) {
    for (const scheme of SCHEMES) {
      const json = await ugOnce({ url, body, scheme, acc, fetchImpl, timeoutMs });
      attempted.push(`${bodyLabel(body)}×${scheme}`);
      const code = Number(json?.code);
      if (code === 0) return json;
      lastCode = code;
      lastMsg = String(json?.message ?? '');
      if (code === 9074) break; // 活动校验拒绝：同源换鉴权方案无意义
    }
  }
  const err = new Error(`签到请求全部被拒 (code=${lastCode}): ${lastMsg} [已尝试 ${attempted.join(',')}]`);
  err.code = lastCode;
  err.attempted = attempted;
  throw err;
}

const checked = (resp) => Boolean(resp?.checked_in || resp?.did_checked_in);

/** 入账数额取其一（client.go CheckinAwarded :921-926）：credits 优先，extra 兜底。 */
function awardedOf(claimResp, statusResp) {
  const credits = Number(claimResp?.credits) || 0;
  if (credits > 0) return credits;
  const extra = Number(claimResp?.extra_credits) || 0;
  if (extra > 0) return extra;
  return Number(statusResp?.credits) || 0;
}

export function createClaimer({
  fetchImpl = fetch,
  now = Date.now,
  bizHost = DEFAULT_BIZ_HOST,
  timeoutMs = TIMEOUT_MS,
} = {}) {
  const statusUrl = `${bizHost}${EP_CHECKIN_STATUS}`;
  const claimUrl = `${bizHost}${EP_CHECKIN_CLAIM}`;

  async function queryStatus(acc) {
    return ugProbe({ url: statusUrl, acc, fetchImpl, timeoutMs });
  }

  async function run(acc, { force = false } = {}) {
    try {
      const st = await queryStatus(acc);
      if (checked(st) && !force) {
        return okResult('already', '今日已签到', { credits: Number(st.credits) || 0, detail: st });
      }
      if (st.enable === false) {
        return okResult('none', '签到活动未开启', { detail: st });
      }
      const claim = await ugProbe({ url: claimUrl, acc, fetchImpl, timeoutMs });
      const after = await queryStatus(acc); // 假成功陷阱：必须回查翻转
      if (!checked(after)) {
        return failResult('claim 返回 code=0 但签到状态未翻转（幂等假成功）', { detail: { claim, after } });
      }
      const credits = awardedOf(claim, st);
      return okResult('claimed', `签到成功${credits ? `（+${credits} 积分）` : ''}`, {
        claimed: ['checkin'],
        credits,
        detail: { claim, after },
      });
    } catch (e) {
      return failResult(e?.message || '签到失败');
    }
  }

  async function status(acc) {
    try {
      const st = await queryStatus(acc);
      return {
        supported: true,
        checkedIn: checked(st),
        claimable: st.enable !== false && !checked(st),
        credits: Number(st.credits) || 0,
        message: checked(st) ? '今日已签到' : st.enable === false ? '签到活动未开启' : '今日未签到',
        details: {
          enable: st.enable !== false,
          didCheckedIn: Boolean(st.did_checked_in),
          extraCredits: Number(st.extra_credits) || 0,
          ...(st.streak_days != null ? { streakDays: Number(st.streak_days) } : {}),
        },
      };
    } catch (e) {
      return { supported: false, checkedIn: false, claimable: false, credits: 0, message: e?.message || '查询失败' };
    }
  }

  return { name: 'trae', run, status };
}
