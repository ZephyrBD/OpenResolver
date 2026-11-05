// 签到/积分：活动查询 + 领取/确认（AK/SK 签名）。
// 移植自 vendor/codearts2api/internal/upstream/checkin.go（MIT © HITZY2002）
// FetchCreditCampaigns :100-115 + creditRequest :53-97（envelope code!=0 → 业务错误）
// + Checkin :119-146 + claimCreditCampaign :148-202。
// 领取语义：**按活动类型/触发模式**选（不再按 campaignId 白名单）——上游每日签到
// 的 campaignId 会漂移（实测 34），固定 id 会永远领不到。排除 INVITE_USER /
// STUDENT_CERTIFIED 与 AUTO_GRANT（由上游自动发放，无需领取）；benefitUnit 为空或 CREDIT；
// ELIGIBLE → claim（幂等键）→ confirm；CLAIMED 只补 confirm；CONFIRMED/CONSUMED 已领。
// 对齐 vendor codearts2api/internal/codearts/welfare.go:82-92 的 IsAutoClaimable。

import {
  EP_CREDIT_DELIVERY,
  EP_CREDIT_CLAIM,
  EP_CREDIT_CONFIRM,
  CREDIT_CHANNEL,
  SNAP_ENGINE_API_HOST,
} from './constants.mjs';
import { signedGet } from './models.mjs';
import { signRequest } from './signer.mjs';

/** 需要人工动作之外的、非签到类活动（邀请/学生认证），不做自动领取。 */
const EXCLUDED_TYPES = new Set(['INVITE_USER', 'STUDENT_CERTIFIED']);

/**
 * USER_LOGIN 的完整生命周期都算「签到活动」：上游对已确认的签到返回 claimable=false，
 * 只看 claimable 会把「已签」误判成「无活动」，面板就永远显示未签。
 */
const USER_LOGIN_STATES = new Set(['ELIGIBLE', 'CLAIMED', 'CONFIRMED', 'CONSUMED']);

/**
 * 是否值得（自动）领取：排除邀请/学生认证与 AUTO_GRANT（上游已自动发放）。
 * claimable 为真即可领；USER_LOGIN 在 claimable=false 时仍纳入——服务端
 * 「已 claim 未 confirm」是 claimable=false + status=CLAIMED，「已 confirm」是
 * claimable=false + status=CONFIRMED，后者只补 confirm / 只用于状态展示。
 */
export function isAutoClaimable(campaign) {
  if (!campaign) return false;
  const type = String(campaign.type ?? '');
  if (EXCLUDED_TYPES.has(type)) return false;
  const triggerMode = String(campaign.extra?.triggerMode ?? '');
  if (triggerMode === 'AUTO_GRANT') return false;
  if (campaign.claimable) return true;
  return type === 'USER_LOGIN' && USER_LOGIN_STATES.has(campaign.status);
}

/**
 * 只读查询积分活动（snap 根路径，Agent-Type: PromptCenter 签名）。
 * cred = {accessKeyID, secretAccessKey, securityToken}。
 * signal 可选（quota 用 AbortSignal.timeout 与积分查询共用同一预算）。
 * envelope {code:0,data:{items:[...]}}；code!=0 → 业务错误带码。
 */
export async function fetchCreditCampaigns({ cred, snapBase, fetchImpl = fetch, signal } = {}) {
  const raw = await signedGet({
    url: `${snapBase}${EP_CREDIT_DELIVERY}?channel=${CREDIT_CHANNEL}`,
    cred,
    agentType: 'PromptCenter',
    fetchImpl,
    signal,
  });
  let envelope;
  try {
    envelope = JSON.parse(raw);
  } catch {
    throw new Error('parse credit activity response: not json');
  }
  if (envelope?.code == null) throw new Error('credit activity response missing business code');
  if (envelope.code !== 0) {
    const err = new Error(envelope.message || `credit activity code=${envelope.code}`);
    err.code = envelope.code;
    throw err;
  }
  const items = envelope.data?.items;
  if (!Array.isArray(items)) throw new Error('credit activity response missing data.items');
  // 脱敏：只留展示/选取所需字段（checkin.go CreditCampaign :22-34），不保留活动票据。
  // type / extra.triggerMode 是领取谓词的输入（id 会漂移，不能按 id 硬编码）。
  return items.map((c) => ({
    campaignId: Number(c.campaignId ?? 0),
    title: String(c.title ?? ''),
    type: String(c.type ?? ''),
    status: String(c.status ?? ''),
    claimable: Boolean(c.claimable),
    benefitUnit: String(c.benefitUnit ?? ''),
    benefitAmount: Number(c.benefitAmount ?? 0),
    pendingTotalAmount: Number(c.pendingTotalAmount ?? 0),
    extra: {
      startTime: c.extra?.startTime ?? '',
      endTime: c.extra?.endTime ?? '',
      triggerMode: String(c.extra?.triggerMode ?? ''),
    },
  }));
}

/** 原始条目（claim 需要 pendingTotalAmount，脱敏版没有）。 */
async function fetchCreditCampaignsRaw({ cred, snapBase, fetchImpl }) {
  const raw = await signedGet({
    url: `${snapBase}${EP_CREDIT_DELIVERY}?channel=${CREDIT_CHANNEL}`,
    cred,
    agentType: 'PromptCenter',
    fetchImpl,
  });
  const envelope = JSON.parse(raw);
  if (envelope?.code !== 0) {
    const err = new Error(envelope?.message || `credit activity code=${envelope?.code}`);
    err.code = envelope?.code;
    throw err;
  }
  return envelope.data?.items ?? [];
}

/** creditRequest 的 POST 面（checkin.go :53-97 同头族 + envelope 解包）。 */
async function creditPost({ url, body, cred, fetchImpl }) {
  const bodyStr = JSON.stringify(body);
  const headers = signRequest(
    {
      method: 'POST',
      url,
      headers: { 'Content-Type': 'application/json', 'Agent-Type': 'PromptCenter', 'X-Language': 'zh-cn' },
      body: bodyStr,
    },
    cred,
  );
  const res = await fetchImpl(url, { method: 'POST', headers, body: bodyStr });
  const text = await res.text().catch(() => '');
  if (!res.ok) {
    const err = new Error(`codearts POST ${url} failed: http=${res.status} ${text.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  let envelope;
  try {
    envelope = JSON.parse(text);
  } catch {
    throw new Error('parse credit response: not json');
  }
  if (envelope?.code == null) throw new Error('credit response missing business code');
  if (envelope.code !== 0) {
    const err = new Error(envelope.message || `credit code=${envelope.code}`);
    err.code = envelope.code;
    throw err;
  }
  return envelope.data;
}

const rfc3339Ms = (s) => {
  const t = Date.parse(String(s ?? ''));
  return Number.isNaN(t) ? null : t;
};

/**
 * 领取签到等可领取积分活动（welfare.go IsAutoClaimable + 本移植的「CLAIMED 补 confirm」语义）。
 * 上游决定资格与每日刷新；已领取不再 claim，CLAIMED 只补 confirm。
 * 返回 {ok, items:[{campaignId,title,status,claimed,credits,message}], credits, message}。
 */
export async function claimCreditCampaigns({ cred, snapBase, fetchImpl = fetch, now = Date.now() } = {}) {
  const campaigns = await fetchCreditCampaignsRaw({ cred, snapBase, fetchImpl });
  const items = [];
  let ok = true;
  for (const campaign of campaigns) {
    const id = Number(campaign.campaignId ?? 0);
    // 按活动类型/触发模式选，不按 campaignId 白名单（上游 id 会漂移）
    if (!isAutoClaimable(campaign)) continue;
    const benefitUnit = String(campaign.benefitUnit ?? '');
    if (benefitUnit !== '' && benefitUnit !== 'CREDIT') continue;

    const item = { campaignId: id, title: String(campaign.title || `积分活动 ${id}`), status: String(campaign.status ?? '').trim(), claimed: false, credits: 0, message: '' };
    const t = Number(now) || Date.now();
    const endMs = rfc3339Ms(campaign.extra?.endTime);
    const startMs = rfc3339Ms(campaign.extra?.startTime);
    if (endMs !== null && t >= endMs) {
      item.message = '活动已结束';
      items.push(item);
      continue;
    }
    if (startMs !== null && t < startMs) {
      item.message = '活动尚未开始';
      items.push(item);
      continue;
    }

    try {
      if (item.status === 'CONFIRMED' || item.status === 'CONSUMED') {
        item.message = '已领取';
      } else if (item.status === 'CLAIMED' || item.status === 'ELIGIBLE') {
        if (item.status === 'ELIGIBLE') {
          if (!campaign.claimable) {
            item.ok = false;
            item.message = '暂不可领取，稍后重试';
            items.push(item);
            ok = false;
            continue;
          }
          await creditPost({
            url: `${snapBase}${EP_CREDIT_CLAIM}`,
            body: { campaignId: id, channel: CREDIT_CHANNEL, idempotentKey: `claim_${id}_${t}` },
            cred,
            fetchImpl,
          });
          item.status = 'CLAIMED';
          item.credits = Number(campaign.pendingTotalAmount) || 0;
          if (item.credits <= 0) item.credits = Number(campaign.benefitAmount) || 0;
        }
        // CLAIMED / 刚领完：补确认
        await creditPost({ url: `${snapBase}${EP_CREDIT_CONFIRM}`, body: { campaignId: id }, cred, fetchImpl });
        item.status = 'CONFIRMED';
        item.claimed = true;
        item.message = item.credits > 0 ? `领取成功（${item.credits} 积分）` : '已补确认';
      } else if (item.status === '') {
        item.message = '未获得活动资格';
      } else {
        item.ok = false;
        item.message = `未知活动状态: ${item.status}`;
        ok = false;
      }
    } catch (e) {
      item.ok = false;
      item.message = e?.message || '领取失败';
      ok = false;
    }
    items.push(item);
  }

  const message = items.map((i) => `${i.title}: ${i.message}`).join('; ') || '无可领取的签到或新手活动';
  return { ok, items, credits: items.reduce((sum, i) => sum + i.credits, 0), message };
}

/** 统一 claimer 工厂（与其它池同形）。acc 需带 accessKeyID/secretAccessKey/securityToken。 */
export function createClaimer({ fetchImpl = fetch, now = Date.now, snapBase = SNAP_ENGINE_API_HOST, credsOf } = {}) {
  // 默认直读账号上的 STS（兼容单测/静态账号）；生产由池注入会刷新的 provider（STS ~2h）。
  const resolveCreds =
    credsOf ??
    ((acc) =>
      acc?.accessKeyID
        ? { accessKeyID: acc.accessKeyID, secretAccessKey: acc.secretAccessKey, securityToken: acc.securityToken }
        : null);

  async function run(acc, { force = false } = {}) {
    try {
      const cred = await resolveCreds(acc);
      if (!cred) {
        return { ok: false, status: 'failed', claimed: [], credits: 0, message: 'CodeArts 凭证不可用，请重新登录' };
      }
      const result = await claimCreditCampaigns({ cred, snapBase, fetchImpl, now: now() });
      const claimed = result.items.filter((i) => i.claimed);
      return {
        ok: result.ok,
        status: claimed.length ? 'claimed' : result.ok ? 'none' : 'failed',
        claimed: claimed.map((i) => String(i.campaignId)),
        credits: result.credits,
        message: result.message,
        detail: { items: result.items },
      };
    } catch (e) {
      return { ok: false, status: 'failed', claimed: [], credits: 0, message: e?.message || '领取失败' };
    }
  }

  async function status(acc) {
    try {
      const cred = await resolveCreds(acc);
      if (!cred) {
        return { supported: false, checkedIn: false, claimable: false, credits: 0, message: 'CodeArts 凭证不可用，请重新登录' };
      }
      const items = await fetchCreditCampaigns({ cred, snapBase, fetchImpl });
      // 与领取侧同一谓词 + 同一 benefitUnit 闸门（POINT 等非积分活动不参与签到展示）
      const mine = items.filter((i) => isAutoClaimable(i) && (i.benefitUnit === '' || i.benefitUnit === 'CREDIT'));
      // 签到只看 USER_LOGIN：新手 AUTO_GRANT 的 4000 积分不参与签到统计
      const daily = mine.filter((i) => i.type === 'USER_LOGIN');
      return {
        supported: true,
        checkedIn: daily.some((i) => i.status === 'CONFIRMED' || i.status === 'CONSUMED'),
        claimable: mine.some((i) => i.claimable),
        credits: daily.reduce((sum, i) => sum + Number(i.benefitAmount || 0), 0),
        message: mine.length ? mine.map((i) => `${i.title}: ${i.status}`).join('; ') : '无进行中的签到活动',
        details: { items: mine },
      };
    } catch (e) {
      return { supported: false, checkedIn: false, claimable: false, credits: 0, message: e?.message || '查询失败' };
    }
  }

  return { name: 'codearts', run, status };
}
