// 模型发现（PROTOCOL.md §105-118，v0.12.51 并发探测）：
// - 企业端点 /console/enterprises/{enterpriseId}/config/models：排序权威（需 enterpriseId）；
// - /v3/config：官方 IDE 配置目录，UA 敏感——必须 CodeBuddyIDE/4.12.0 CodeBuddy/4.12.0
//   （CLI UA 得到削减表），头族逐条 §106，三 realm（copilot.tencent.com / www.codebuddy.cn /
//   www.codebuddy.ai）各自 {upstreamBase}/v3/config，X-Domain 带对应 realm 域名；
// - 响应信封 {code,data:{models:[...]}}；合并 key=模型 id，企业管排序、v3 补能力 + 追加独有条目；
//   单路失败降级其它路，全部失败降级静态表（verified=false）。
// - nonChatModel 过滤（§118）：id 前缀 nes-/completion-/codewise-、maxOutput<=256、
//   supportsExtra、tags 含 text-to-image → 不进可选列表。
// - 能力字段兼容两代字段名（§107/§117）：ContextLength/InputTokenLimit/contextWindow/maxInputTokens、
//   MaxCompletionTokens/OutputTokenLimit/maxOutputTokens、Thinking.Levels/reasoning.supportedEfforts。

import { ENTERPRISE_MODELS_PATH, EP_V3_CONFIG, DISCOVERY_UA, FALLBACK_MODELS, REALM_BASES } from './constants.mjs';
import { authHeaders } from './headers.mjs';
import { unwrap } from './auth.mjs';

const NON_CHAT_PREFIXES = ['nes-', 'completion-', 'codewise-'];

function rawModelsFrom(json) {
  const payload = unwrap(json);
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.models)) return payload.models;
  return [];
}

/** nonChatModel 过滤（§118 镜像 harness buddy.ts isChatModel）。 */
export function isNonChatModel(m) {
  const id = String(m?.id ?? '');
  if (NON_CHAT_PREFIXES.some((p) => id.startsWith(p))) return true;
  const maxOutput = Number(m?.MaxCompletionTokens ?? m?.OutputTokenLimit ?? m?.maxOutputTokens ?? NaN);
  if (Number.isFinite(maxOutput) && maxOutput <= 256) return true;
  if (m?.supportsExtra === true) return true;
  const tags = Array.isArray(m?.tags) ? m.tags : [];
  return tags.includes('text-to-image');
}

/** 两代能力字段 → 网关模型形状。 */
function toGatewayModel(m) {
  const contextWindow = Number(m.ContextLength ?? m.contextWindow ?? m.InputTokenLimit ?? m.maxInputTokens ?? 0) || undefined;
  const maxTokens = Number(m.MaxCompletionTokens ?? m.OutputTokenLimit ?? m.maxOutputTokens ?? 0) || undefined;
  const thinkingLevels = m.Thinking?.Levels ?? m.reasoning?.supportedEfforts;
  return {
    id: String(m.id),
    display_name: String(m.name ?? m.Name ?? m.id),
    ...(contextWindow ? { context_window: contextWindow } : {}),
    ...(maxTokens ? { max_tokens: maxTokens } : {}),
    supports_tools: (m.SupportsToolCall ?? m.supportsToolCall) !== false,
    supports_thinking: (m.SupportsReasoning ?? m.supportsReasoning) != null
      ? m.SupportsReasoning ?? m.supportsReasoning
      : Boolean(thinkingLevels?.length),
  };
}

function configHeaders(acc, domain) {
  // §106 逐头：Authorization + Accept + X-Requested-With + X-Domain + X-Product + X-CodeBuddy-Request + X-User-Id
  const h = {
    'User-Agent': DISCOVERY_UA,
    Authorization: `Bearer ${acc?.jwt ?? ''}`,
    Accept: 'application/json, text/plain, */*',
    'X-Requested-With': 'XMLHttpRequest',
    'X-Product': 'SaaS',
    'X-CodeBuddy-Request': '1',
    'X-Domain': domain,
  };
  if (acc?.uid != null && acc?.uid !== '') h['X-User-Id'] = String(acc.uid);
  return h;
}

export function createWorkbuddyModelCatalog({
  region,
  endpoint,
  fetchImpl = fetch,
  now = Date.now,
  ttlMs = 10 * 60_000,
  realmBases = REALM_BASES,
} = {}) {
  const cache = { models: FALLBACK_MODELS[region].map((m) => ({ verified: false, supports_tools: true, supports_thinking: true, ...m })), fetchedAt: 0, source: 'static' };
  let probing = null;

  async function probePath(url, headers) {
    const res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`模型探测失败 HTTP ${res.status} ${url}`);
    const list = rawModelsFrom(await res.json());
    if (!list.length) throw new Error(`模型探测空表 ${url}`);
    return list;
  }

  /**
   * 并发探测（§105-114）：企业端点 + 三 realm 的 /v3/config。返回 {models, source}；
   * 单路失败降级其它路，全部失败抛错（调用方保留静态降级表）。
   */
  async function discover(acc) {
    const paths = [];
    if (acc?.enterpriseId) {
      paths.push({
        name: 'enterprise',
        url: `${endpoint}${ENTERPRISE_MODELS_PATH.replace('{enterpriseId}', encodeURIComponent(String(acc.enterpriseId)))}`,
        headers: authHeaders(acc, { endpoint }),
      });
    }
    for (const base of realmBases) {
      paths.push({ name: 'v3', url: `${base}${EP_V3_CONFIG}`, headers: configHeaders(acc, new URL(base).host) });
    }

    const settled = await Promise.allSettled(paths.map((p) => probePath(p.url, p.headers)));
    const results = settled.map((r, i) => ({ ...paths[i], ok: r.status === 'fulfilled', list: r.status === 'fulfilled' ? r.value : null, reason: r.status === 'rejected' ? r.reason?.message : null }));
    const okPaths = results.filter((r) => r.ok);
    if (!okPaths.length) {
      throw new Error(`模型探测全部失败：${results.map((r) => `${r.name}@${new URL(r.url).host}: ${r.reason}`).join('; ')}`);
    }
    const enterprise = results.find((r) => r.name === 'enterprise' && r.ok);
    const v3Realms = results.filter((r) => r.name === 'v3' && r.ok);

    // 企业管排序权威；v3 各 realm 补能力 + 追加独有条目（按 realm 顺序联合）
    const merged = new Map();
    for (const p of [enterprise, ...v3Realms].filter(Boolean)) {
      for (const raw of p.list) {
        if (!raw?.id) continue;
        const prev = merged.get(raw.id);
        if (!prev) merged.set(raw.id, raw);
        else merged.set(raw.id, { ...raw, ...prev, __ordered: true });
      }
    }
    const models = [...merged.values()].filter((m) => !isNonChatModel(m)).map(toGatewayModel);
    if (!models.length) throw new Error('模型探测过滤后为空');
    const source = [enterprise && 'enterprise', v3Realms.length && 'v3'].filter(Boolean).join('+');
    return { models, source };
  }

  async function refreshModels(acc) {
    // 无凭证不探测（避免拿空 Bearer 打真实上游）；保留静态降级表
    if (!acc?.jwt) return false;
    try {
      const { models, source } = await discover(acc);
      cache.models = models;
      cache.fetchedAt = now();
      cache.source = source;
      cache.error = null;
      return true;
    } catch (err) {
      // cache 保有构造时注入的静态降级表，全部失败时保留
      cache.error = err?.message;
      return false;
    }
  }

  function ensureFresh(acc) {
    const t = now();
    if (cache.models && t - cache.fetchedAt < ttlMs) return Promise.resolve(true);
    if (!probing) probing = refreshModels(acc).finally(() => (probing = null));
    return probing;
  }

  return {
    models: () => (cache.models ?? []).map((m) => ({ ...m })),
    configFor: (id) => (cache.models ?? []).find((m) => m.id === id) ?? null,
    refreshModels,
    ensureFresh,
    get source() {
      return cache.source ?? null;
    },
    get error() {
      return cache.error ?? null;
    },
  };
}
