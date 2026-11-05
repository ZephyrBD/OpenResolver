// model/list 拉取 + 缓存（移植自 pi-provider-qoder :215-236, :618-754，MIT）。
// 响应里的 model_config 整块缓存到 data/pools/qoder*/models-cache.json（tmp+rename）。
// 拉取失败回落静态兜底表（degraded 标记）。模型 ID = display_name 去空格（toQoderModelId）。

import fs from 'node:fs';
import path from 'node:path';
import { buildAuthHeaders } from './cosy.mjs';
import { modelListUrl } from './region.mjs';

export const MAX_OUTPUT_TOKENS = 131072;
export const DEFAULT_CONTEXT_WINDOW = 1e6;

export function toQoderModelId(displayName) {
  return (displayName || 'QoderModel').replace(/\s+/g, '');
}

// 静态兜底表：从源码 catalog 抄常见模型（global / cn 各留几条）
const STATIC_FALLBACK = {
  global: [
    { key: 'auto', display_name: 'Auto', is_reasoning: true },
    { key: 'ultimate', display_name: 'Ultimate', is_reasoning: true },
    { key: 'performance', display_name: 'Performance', is_reasoning: true },
    { key: 'qmodel_latest', display_name: 'Qwen3.7-Max', is_reasoning: false },
    { key: 'dmodel', display_name: 'DeepSeek-V4-Pro', is_reasoning: true },
  ],
  cn: [
    { key: 'auto', display_name: 'Auto', is_reasoning: true },
    { key: 'qmodel_latest', display_name: 'Qwen3.7-Max', is_reasoning: true },
    { key: 'dmodel', display_name: 'DeepSeek-V4-Pro', is_reasoning: true },
    { key: 'gm51model', display_name: 'GLM-5.2', is_reasoning: true },
  ],
};

const STALE_MS = 3_600_000;

export function createModelCatalog({ mode, cacheFile, fetchImpl = fetch, now = Date.now, url } = {}) {
  let memory = null; // { updatedAt, models:[...], configs:{id:entry} }
  let degraded = false;

  function readCache() {
    if (memory) return memory;
    try {
      memory = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    } catch {
      memory = null;
    }
    return memory;
  }

  function writeCache(data) {
    try {
      fs.mkdirSync(path.dirname(cacheFile), { recursive: true, mode: 0o700 });
      const tmp = `${cacheFile}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, cacheFile);
      memory = data;
    } catch {
      // 缓存写失败不致命
    }
  }

  function isStale() {
    const data = readCache();
    return !data || typeof data.updatedAt !== 'number' || now() - data.updatedAt > STALE_MS;
  }

  /** GET model/list（COSY 头，源码 :695-710 就是这么发的）。成功写缓存；失败静默回落。 */
  async function refresh(acc, { userID } = {}) {
    const listUrl = url || modelListUrl(mode);
    try {
      const headers = buildAuthHeaders(null, listUrl, {
        userID: userID || acc.userID || 'qoder-user',
        authToken: acc.jobToken,
        name: acc.name || '',
        email: acc.email || '',
        machineID: acc.machineID,
      });
      const res = await fetchImpl(listUrl, { method: 'GET', headers: { Accept: 'application/json', ...headers } });
      if (!res.ok) return false;
      const resData = await res.json();
      const chatModels = resData.chat || [];
      if (!chatModels.length) return false;
      const models = [];
      const configs = {};
      for (const entry of chatModels) {
        if (!entry.key || !entry.enable || !entry.display_name) continue;
        const id = toQoderModelId(entry.display_name);
        configs[id] = entry;
        let contextWindow = DEFAULT_CONTEXT_WINDOW;
        if (entry.context_config && typeof entry.context_config === 'object') {
          let advertised = 0;
          for (const cfg of Object.values(entry.context_config)) {
            if (cfg && typeof cfg === 'object' && typeof cfg.token_count === 'number' && cfg.token_count > advertised) {
              advertised = cfg.token_count;
            }
          }
          if (advertised > 0) contextWindow = advertised;
        }
        models.push({
          id,
          display_name: entry.display_name,
          key: entry.key,
          is_reasoning: !!entry.is_reasoning || !!entry.thinking_config,
          context_window: contextWindow,
        });
      }
      if (!models.length) return false;
      degraded = false;
      writeCache({ updatedAt: now(), models, configs });
      return true;
    } catch {
      degraded = true;
      return false;
    }
  }

  function models() {
    const data = readCache();
    if (data && Array.isArray(data.models) && data.models.length) {
      return data.models.map((m) => ({ ...m, upstream_model: m.key || m.id, supports_tools: true, supports_thinking: !!m.is_reasoning, degraded: false }));
    }
    return STATIC_FALLBACK[mode].map((m) => ({
      id: toQoderModelId(m.display_name),
      display_name: m.display_name,
      key: m.key,
      upstream_model: m.key || m.id,
      is_reasoning: m.is_reasoning,
      context_window: DEFAULT_CONTEXT_WINDOW,
      supports_tools: true,
      supports_thinking: m.is_reasoning,
      degraded: true,
    }));
  }

  /** 模型 id → model/list 缓存里的整块条目；静态兜底 {key, is_reasoning, source:'system'}。 */
  function configFor(modelId) {
    const data = readCache();
    const direct = data?.configs?.[modelId];
    if (direct && toQoderModelId(direct.display_name) === modelId) return direct;
    const legacy = Object.values(data?.configs || {}).find((e) => e && toQoderModelId(e.display_name) === modelId);
    if (legacy) return legacy;
    const staticEntry = models().find((m) => m.id === modelId);
    if (staticEntry) return { key: staticEntry.key || modelId, is_reasoning: !!staticEntry.is_reasoning, source: 'system' };
    return null;
  }

  return { models, configFor, refresh, isStale, get degraded() { return degraded; } };
}
