// Qoder 活动福利领取（campaigns claim）。GET/POST
// {openApiUrl}/sash/api/v1/me/campaigns[...]/claim，jobToken 鉴权 + COSY 头。
// campaigns 列表形状三选一：顶层数组 / data.campaigns / items。run() 绝不抛出。

import { QODER_OPENAPI_COSY_VERSION, QODER_CLIENT_TYPE } from './cosy.mjs';

const TIMEOUT_MS = 15_000;

const okResult = (status, message, extra = {}) => ({ ok: true, status, claimed: [], credits: 0, message, ...extra });
const failResult = (message, extra = {}) => ({ ok: false, status: 'failed', claimed: [], credits: 0, message, ...extra });

function headersFor(acc) {
  return {
    Accept: 'application/json',
    Authorization: `Bearer ${acc.jobToken || acc.pat || ''}`,
    'User-Agent': 'unified-gateway',
    'Cosy-Version': QODER_OPENAPI_COSY_VERSION,
    'Cosy-ClientType': QODER_CLIENT_TYPE,
  };
}

/** 三种列表形状统一展开（顶层数组 / data.campaigns / items）。 */
export function campaignsOf(json) {
  if (Array.isArray(json)) return json;
  if (Array.isArray(json?.data?.campaigns)) return json.data.campaigns;
  if (Array.isArray(json?.items)) return json.items;
  if (Array.isArray(json?.data)) return json.data;
  return [];
}

export const isClaimable = (c) => c?.actionType === 'CLAIM_BENEFIT' && c?.claimStatus === 'CLAIMABLE';

export function createClaimer({
  fetchImpl = fetch,
  now = Date.now,
  openApiUrl = 'https://openapi.qoder.sh',
  name = 'qoder',
  timeoutMs = TIMEOUT_MS,
} = {}) {
  async function request(acc, path, body) {
    const res = await fetchImpl(`${openApiUrl}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { ...headersFor(acc), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`HTTP ${res.status} 响应不是合法 JSON`);
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${json?.message ?? text.slice(0, 120)}`);
    return json;
  }

  async function listCampaigns(acc) {
    return campaignsOf(await request(acc, '/sash/api/v1/me/campaigns?forceRefresh=true'));
  }

  async function run(acc, { force = false } = {}) {
    try {
      const campaigns = await listCampaigns(acc);
      const claimable = campaigns.filter(isClaimable);
      if (!campaigns.length) {
        return okResult('none', '没有可参与的活动', { detail: { campaigns: 0 } });
      }
      if (!claimable.length) {
        return okResult('already', '没有可领取的福利（均已领取或不满足条件）', {
          detail: { campaigns: campaigns.length },
        });
      }

      const claimed = [];
      let credits = 0;
      for (const c of claimable) {
        const j = await request(acc, `/sash/api/v1/me/campaigns/${encodeURIComponent(c.id)}/claim`, {});
        const replayed = j?.replayed === true;
        const amount = Number(j?.benefit?.amount ?? c?.benefit?.amount ?? 0) || 0;
        if (replayed || j?.status === 'CLAIMED') {
          if (!replayed) {
            claimed.push(String(c.id));
            credits += amount;
          }
        } else {
          return failResult(`领取 ${c.id} 失败: ${j?.message ?? j?.status ?? '未知响应'}`, {
            claimed,
            credits,
            detail: { campaigns: campaigns.length, last: j },
          });
        }
      }
      return claimed.length
        ? okResult('claimed', `已领取 ${claimed.length} 项福利`, { claimed, credits })
        : okResult('already', '福利此前已领取过', { credits, detail: { campaigns: campaigns.length } });
    } catch (e) {
      return failResult(e?.message || '领取失败');
    }
  }

  async function status(acc) {
    try {
      const campaigns = await listCampaigns(acc);
      const claimable = campaigns.filter(isClaimable).length;
      const claimed = campaigns.filter((c) => c?.claimStatus === 'CLAIMED').length;
      const credits = campaigns.reduce((sum, c) => sum + (Number(c?.benefit?.amount) || 0), 0);
      return {
        supported: true,
        checkedIn: campaigns.length > 0 && claimable === 0,
        claimable: claimable > 0,
        credits,
        message: `活动 ${campaigns.length} 项：可领 ${claimable}，已领 ${claimed}`,
        details: { claimable, claimed, total: campaigns.length },
      };
    } catch (e) {
      return { supported: false, checkedIn: false, claimable: false, credits: 0, message: e?.message || '查询失败' };
    }
  }

  return { name, run, status };
}
