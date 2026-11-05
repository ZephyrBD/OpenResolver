// 模型目录：三路发现（agent-center / builtin / benefit）+ 福利幂等领取 + srcFail 退避。
// 移植自 vendor/codearts2api/internal/upstream/models.go（MIT © HITZY2002）：
//   catalog :84-97 / setAccountModels :99-167 / IsBenefitModel :196-212 /
//   CanonicalModel :418-438 / MergeModels :228-256 / FetchModels :292-329 /
//   fetchAgentModels :332-377 / defaultAgentID :382-415 / fetchBuiltinModels :417-470 /
//   ClaimBenefit :476-510 / fetchBenefitModels :513-581。
//
// 关键语义（简报核对）：
// - 福利模型必须先幂等领取 EpBenefitClaim（否则 InferHub.4004.200 benefit not found），
//   claimAuto 默认开；官方客户端打开模型菜单也调用。
// - 目录按账号隔离（benefit 按账号授予）。isBenefit 语义（本仓库收紧过）：
//   目录存在 → 只信目录（福利集合内 true，其余一律 false）；目录缺失才回退冷启动种子。
//   旧版「目录已知 → 种子」会让上游已下架的种子模型继续带 maas_type: benefit，
//   触发 TM.000010051 无权调用。
// - 账号键统一走 accountKeyOf：live 账号 userId 可能为空，回退 id，避免目录被丢弃。
// - 同来源失败退避 5min（client.go:129 srcFailCooldown），避免每次 /v1/models 空等超时。
// - 福利来源失败但内置成功：保留上轮福利条目（keepBenefit），别把 maas_type 头弄丢。

import {
  EP_AGENT_LIST, EP_AGENT_DETAIL, EP_MODEL_BUILTIN,
  EP_BENEFIT_CONFIG, EP_BENEFIT_CLAIM,
} from './constants.mjs';
import { signRequest } from './signer.mjs';

export const CATALOG_TTL_MS = 3_600_000;
export const SRC_FAIL_COOLDOWN_MS = 5 * 60_000;

// 冷启动种子：仅在首次发现成功前使用。ID 必须是上游 builtin 的 model_id
// （上游区分大小写，用显示名会报 TM.000010051 无权调用）。
// 2026-10 起免费权益（benefit）通道整体下线，不再有 benefit 种子。
export const SEED_BENEFIT_MODELS = [];
export const SEED_KNOWN_MODELS = [
  'glm-5.3', 'GLM-5.2', 'glm-5.2-sft-harmony',
  'openpangu-2.0-pro', 'openpangu-2.0-flash',
  'deepseek-v4.1-flash', 'deepseek-v4.1-flash-1017',
  'Qwen3-VL-235B', 'kimi-k2.6-vl', 'kimi-k3', 'kimi-k3.1-pro', 'speed',
];

// CanonicalModel 静态别名兜底（client.go:418-438；动态 known 索引优先）。
const STATIC_ALIASES = {
  'snap-chat': 'GLM-5.2',
  'glm-5.2': 'GLM-5.2',
  'glm-5.3': 'glm-5.3',
  'glm-5.3-flash': 'glm-5.3-flash',
  'glm-5.2-arkts-spark': 'glm-5.2-sft-harmony',
  '智速模式': 'speed',
  'qwen3-vl-235b': 'Qwen3-VL-235B',
  'kimi-k2.6-vl': 'kimi-k2.6-vl',
};

const firstNonEmpty = (...values) => values.find((v) => v != null && v !== '') ?? '';

/**
 * 账号目录键：优先 userId，缺失回退持久化的 id（live 账号 userId 可能为空串）。
 * 目录/福利判定/模型列表三处必须用同一个键，否则发现成功的目录会被丢弃。
 */
export const accountKeyOf = (acc) => String(acc?.userId || acc?.id || '');

export async function signedGet({ url, cred, agentType, fetchImpl, signal }) {
  const headers = signRequest(
    {
      method: 'GET',
      url,
      headers: { 'Content-Type': 'application/json', 'X-Language': 'zh-cn', ...(agentType ? { 'Agent-Type': agentType } : {}) },
      body: '',
    },
    cred,
  );
  const res = await fetchImpl(url, { headers, signal });
  const text = await res.text().catch(() => '');
  if (!res.ok) {
    const err = new Error(`codearts GET ${url} failed: http=${res.status} ${text.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  return text;
}

export function createCodeartsModelCatalog({
  now = Date.now,
  fetchImpl = fetch,
  snapBase,
  benefitBase,
  claimAuto = true,
  srcFailCooldownMs = SRC_FAIL_COOLDOWN_MS,
} = {}) {
  // known：lower(id) → 精确 ID（种子 + 已发现，跨账号共享）。
  const known = new Map();
  for (const id of [...SEED_KNOWN_MODELS, ...SEED_BENEFIT_MODELS]) {
    if (!known.has(id.toLowerCase())) known.set(id.toLowerCase(), id);
  }
  const seedBenefit = new Set(SEED_BENEFIT_MODELS.map((id) => id.toLowerCase()));
  // accounts：accountId → {models, benefit:Set, knows:Set, lastBenefit:Map, fetchedAt}
  const accounts = new Map();
  const srcFail = new Map(); // `${accountId}|${source}` → 失效时刻

  const srcBlocked = (key) => (srcFail.get(key) ?? 0) > now();
  const noteSrcFail = (key) => srcFail.set(key, now() + srcFailCooldownMs);
  const clearSrcFail = (key) => srcFail.delete(key);

  /** CanonicalModel：known 大小写不敏感归一 → 静态别名 → 原样透传。 */
  function canonicalModel(id) {
    const key = String(id ?? '').trim().toLowerCase();
    if (!key) return id;
    if (known.has(key)) return known.get(key);
    return STATIC_ALIASES[key] ?? id;
  }

  // setAccountModels（models.go:110-167）：整体替换 + keepBenefit 保留上轮福利。
  function setAccountModels(accountId, infos, keepBenefit) {
    if (!accountId) return;
    const prev = accounts.get(accountId);
    const entry = {
      models: infos,
      benefit: new Set(),
      knows: new Set(),
      lastBenefit: prev ? new Map(prev.lastBenefit) : new Map(),
      fetchedAt: now(),
    };
    for (const mi of infos) {
      if (!mi?.id) continue;
      const key = mi.id.toLowerCase();
      entry.knows.add(key);
      if (mi.benefit) {
        entry.benefit.add(key);
        entry.lastBenefit.set(key, mi);
      }
      if (!known.has(key) || mi.id !== key) known.set(key, mi.id);
    }
    if (keepBenefit) {
      for (const [key, mi] of entry.lastBenefit) {
        if (entry.knows.has(key)) continue; // 内置来源明确登记 → 已转正
        entry.benefit.add(key);
        entry.knows.add(key);
        entry.models.push(mi);
        if (!known.has(key) || mi.id !== key) known.set(key, mi.id);
      }
      entry.models.sort((a, b) => {
        const la = a.id.toLowerCase();
        const lb = b.id.toLowerCase();
        return la !== lb ? (la < lb ? -1 : 1) : a.id.localeCompare(b.id);
      });
    }
    accounts.set(accountId, entry);
  }

  /**
   * IsBenefitModel（models.go:196-212 的收紧版）：目录存在即权威——福利集合内 true，
   * 其余（含未知模型）false；只有在没有任何目录时才回退冷启动种子。
   */
  function isBenefit(accountId, model) {
    const key = String(model ?? '').trim().toLowerCase();
    if (!key) return false;
    const entry = accounts.get(accountId);
    if (entry) return entry.benefit.has(key);
    return seedBenefit.has(key);
  }

  // MergeModels（models.go:228-256）：按小写 ID 去重。
  // ID 优先取 builtin 来源：上游校验 model-id 与请求体完全一致，而 agent
  // 详情里给的是显示名（如 GLM-5.3-Flash），直接用会报 TM.000010051。
  function mergeModels(sets) {
    const merged = new Map();
    for (const set of sets) {
      for (const mi of set) {
        if (!mi?.id) continue;
        const key = mi.id.toLowerCase();
        const cur = merged.get(key);
        if (!cur) {
          merged.set(key, { ...mi });
          continue;
        }
        const preferIncoming = mi.source === 'builtin' && cur.source !== 'builtin';
        merged.set(key, {
          ...cur,
          id: preferIncoming ? mi.id : cur.id,
          name: preferIncoming ? mi.name || mi.id : cur.name || cur.id,
          source: preferIncoming ? 'builtin' : cur.source,
          benefit: Boolean(cur.benefit || mi.benefit),
          context_window: Math.max(cur.context_window || 0, mi.context_window || 0),
          max_tokens: Math.max(cur.max_tokens || 0, mi.max_tokens || 0),
          desc: cur.desc || mi.desc,
        });
      }
    }
    return [...merged.values()].sort((a, b) => {
      const la = a.id.toLowerCase();
      const lb = b.id.toLowerCase();
      return la !== lb ? (la < lb ? -1 : 1) : a.id.localeCompare(b.id);
    });
  }

  // defaultAgentID（models.go:382-415）：CodeAgent+智能体+show_in_ide → primary → 首个。
  async function defaultAgentId(cred) {
    const raw = await signedGet({
      url: `${snapBase}${EP_AGENT_LIST}?offset=0&limit=100&is_primary_agent=true`,
      cred,
      agentType: 'AgentCenter',
      fetchImpl,
    });
    const out = JSON.parse(raw);
    const agents = out?.agents ?? [];
    const preferred = agents.find((a) => a.agent_name === 'CodeAgent' && a.alias?.alias_zh_cn === '智能体' && a.show_in_ide);
    if (preferred) return preferred.agent_id;
    const primary = agents.find((a) => a.is_primary_agent);
    if (primary) return primary.agent_id;
    return agents[0]?.agent_id ?? '';
  }

  async function fetchAgentModels(cred) {
    const agentId = await defaultAgentId(cred);
    if (!agentId) throw new Error('no default agent found');
    const raw = await signedGet({
      url: `${snapBase}${EP_AGENT_DETAIL}?agent_id=${encodeURIComponent(agentId)}`,
      cred,
      agentType: 'AgentCenter',
      fetchImpl,
    });
    const detail = JSON.parse(raw);
    return (detail?.gpts?.models ?? []).map((m) => {
      const id = firstNonEmpty(m.model_name, m.model_id, m.model_alias, m.model_parameters?.model_id);
      return id
        ? {
            id,
            name: id,
            source: 'agent',
            context_window: Number(m.model_parameters?.context_window ?? 0),
            max_tokens: Number(m.model_parameters?.max_tokens ?? 0),
            desc: m.model_parameters?.model_desc ?? '',
          }
        : null;
    }).filter(Boolean);
  }

  async function fetchBuiltinModels(accountId, cred) {
    const key = `${accountId}|builtin`;
    if (srcBlocked(key)) throw new Error('builtin source backoff');
    try {
      const raw = await signedGet({ url: `${snapBase}${EP_MODEL_BUILTIN}`, cred, agentType: 'PromptCenter', fetchImpl });
      const out = JSON.parse(raw);
      const infos = (out?.builtinModels ?? []).map((m) => {
        const id = firstNonEmpty(m.model_id, m.model_name);
        return id
          ? {
              id,
              name: firstNonEmpty(m.model_name, id),
              source: 'builtin',
              context_window: Number(m.context_window ?? 0),
              max_tokens: Number(m.max_tokens ?? 0),
              desc: m.model_desc ?? '',
            }
          : null;
      }).filter(Boolean);
      clearSrcFail(key);
      return infos;
    } catch (err) {
      noteSrcFail(key);
      throw err;
    }
  }

  // ClaimBenefit（models.go:476-510）：幂等领取；error_code=0000 视为成功。
  async function claimBenefit(cred) {
    const body = JSON.stringify({});
    const headers = signRequest(
      {
        method: 'POST',
        url: `${benefitBase}${EP_BENEFIT_CLAIM}`,
        headers: { 'Content-Type': 'application/json', 'X-Language': 'zh-cn' },
        body,
      },
      cred,
    );
    const res = await fetchImpl(`${benefitBase}${EP_BENEFIT_CLAIM}`, { method: 'POST', headers, body });
    const text = await res.text().catch(() => '');
    if (!res.ok) throw new Error(`benefit claim failed: http=${res.status} ${text.slice(0, 200)}`);
    const out = JSON.parse(text);
    if (out?.error_code !== '0000') throw new Error(`claim failed: error_code=${out?.error_code} msg=${out?.error_msg}`);
  }

  async function fetchBenefitModels(accountId, cred) {
    const key = `${accountId}|benefit`;
    if (srcBlocked(key)) throw new Error('benefit source backoff');
    try {
      if (claimAuto) {
        await claimBenefit(cred).catch(() => {}); // 领取失败不阻断发现（models.go:518-522）
      }
      const raw = await signedGet({ url: `${benefitBase}${EP_BENEFIT_CONFIG}`, cred, fetchImpl });
      const out = JSON.parse(raw);
      if (out?.error_code !== '0000') throw new Error(`gateway/config error_code=${out?.error_code}`);
      clearSrcFail(key);
      return (out?.result?.models ?? []).map((m) => {
        const id = firstNonEmpty(m.model_id, m.model_name);
        return id
          ? {
              id, name: id,
              source: 'benefit',
              context_window: Number(m.context_window ?? 0),
              max_tokens: Number(m.max_tokens ?? 0),
              desc: m.model_desc ?? '',
              benefit: true,
            }
          : null;
      }).filter(Boolean);
    } catch (err) {
      noteSrcFail(key);
      throw err;
    }
  }

  /**
   * refreshModels(acc)（FetchModels :292-329）：三路发现，单路失败不阻断；
   * 全空才算失败。acc 需带 accessKeyID/secretAccessKey/securityToken，键取 accountKeyOf。
   */
  async function refreshModels(acc) {
    if (!acc) return false;
    const cred = {
      accessKeyID: acc.accessKeyID,
      secretAccessKey: acc.secretAccessKey,
      securityToken: acc.securityToken,
    };
    const accountId = accountKeyOf(acc);
    const sets = [];
    let agentModels = [];
    let builtinModels = [];
    let benefitModels = [];
    let agentOk = false;
    try {
      agentModels = await fetchAgentModels(cred);
      agentOk = true;
    } catch {
      /* 单路失败只降级 */
    }
    let builtinOk = false;
    try {
      builtinModels = await fetchBuiltinModels(accountId, cred);
      builtinOk = true;
    } catch {
      /* 同上 */
    }
    let benefitOk = false;
    try {
      benefitModels = await fetchBenefitModels(accountId, cred);
      benefitOk = true;
    } catch {
      /* 同上 */
    }

    // builtin 是唯一权威的可调用清单：其 model_id 可直接当请求体的 model。
    // agent 详情给的是显示名（GLM-5.3-Flash / 智速模式），只能按 id 或显示名
    // 映射回 builtin ID 后再合并，绝不能作为独立模型暴露给客户端。
    if (builtinOk && builtinModels.length) {
      const byId = new Map(builtinModels.map((m) => [m.id.toLowerCase(), m]));
      const byName = new Map(
        builtinModels.filter((m) => m.name).map((m) => [String(m.name).toLowerCase(), m]),
      );
      const mappedAgent = agentModels
        .map((m) => {
          const target = byId.get(m.id.toLowerCase()) || byName.get(String(m.name || m.id).toLowerCase());
          return target ? { ...m, id: target.id, name: target.name || m.name } : m;
        })
        .filter((m) => byId.has(m.id.toLowerCase()));
      sets.push(mappedAgent, builtinModels);
      if (benefitOk && benefitModels.length) sets.push(benefitModels);
    } else {
      sets.push(agentModels, builtinModels, benefitModels);
    }
    const merged = mergeModels(sets);
    if (!merged.length) {
      catalog.source = 'static';
      return false;
    }
    setAccountModels(accountId, merged, builtinOk && !benefitOk);
    const sources = [agentOk && 'agent', builtinOk && 'builtin', benefitOk && 'benefit'].filter(Boolean);
    catalog.source = sources.join('+') || 'static';
    return true;
  }

  /** 账号目录快照 → 网关 /v1/models 形状；未发现（或超 TTL）时静态种子降级。 */
  function models(accountId) {
    const entry = accountId ? accounts.get(accountId) : null;
    if (entry) {
      return entry.models.map((m) => ({
        id: m.id,
        display_name: m.name || m.id,
        context_window: m.context_window || undefined,
        max_tokens: m.max_tokens || undefined,
        supports_tools: true,
        supports_thinking: true,
        benefit: Boolean(m.benefit),
      }));
    }
    return [
      ...SEED_KNOWN_MODELS.map((id) => ({ id, display_name: id, supports_tools: true, supports_thinking: true })),
      ...SEED_BENEFIT_MODELS.map((id) => ({ id, display_name: id, supports_tools: true, supports_thinking: true, benefit: true })),
    ];
  }

  function isStale(accountId) {
    const entry = accounts.get(accountId);
    return !entry || now() - entry.fetchedAt >= CATALOG_TTL_MS;
  }

  const catalog = {
    source: 'static',
    refreshModels,
    models,
    isBenefit,
    canonicalModel,
    isStale,
    /** 签到等只读调用共用（无需 catalog 状态）。 */
    signedGet,
  };

  return catalog;
}
