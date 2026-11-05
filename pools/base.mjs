import crypto from 'node:crypto';
import { DEFAULT_SETTINGS, SETTING_KEYS, clampSetting, patchSettings as persistSettings } from './settings.mjs';

/**
 * 与协议无关的多账号池调度器（文档 §6 / §6.1 / §6.2 / §6.3）。
 *
 * weight = (quotaFactor + idleBonus + successFactor) × manualWeight
 *   quotaFactor   = quotaRatio × 10        （null → 按 0，不惩罚）
 *   idleBonus     = min(闲置小时 × 0.5, 5)  （从未用过按 999 小时）
 *   successFactor = 最近 50 次成功率 × 3
 *   manualWeight  = clamp(0..20)；0 = 硬过滤
 */

const DEFAULT_MANUAL_WEIGHT = 10;
const SUCCESS_WINDOW = 50;
const NEVER_USED_HOURS = 999;

const clampManual = (v) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return DEFAULT_MANUAL_WEIGHT;
  return Math.min(20, Math.max(0, n));
};

const clampRatio = (v) => {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  return Math.min(1, Math.max(0, v));
};

function headerValue(headers, name) {
  const raw = headers?.[name];
  if (Array.isArray(raw)) return raw[0];
  return typeof raw === 'string' && raw.trim() ? raw.trim() : null;
}

function firstUserText(body) {
  const messages = body?.messages;
  if (!Array.isArray(messages)) return '';
  const msg = messages.find((m) => m?.role === 'user');
  if (!msg) return '';
  if (typeof msg.content === 'string') return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content
      .filter((block) => block?.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('\n');
  }
  return '';
}

/**
 * 粘性会话 key：头优先，最后回退到首条 user 文本；必须混入 API key id，
 * 否则不同密钥的同一句话会撞到同一个账号。
 * 完全无来源（无头、无 user 文本）时返回 null —— 不启用粘性。
 */
export function sessionKeyOf({ req, body, keyId } = {}) {
  const headers = req?.headers || {};
  let source =
    headerValue(headers, 'x-ugw-session') ||
    headerValue(headers, 'x-session-id') ||
    headerValue(headers, 'x-conversation-id') ||
    (typeof body?.metadata?.conversation_id === 'string' ? body.metadata.conversation_id : null);

  if (!source) {
    const text = firstUserText(body);
    if (!text) return null;
    source = crypto.createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16);
  }
  return crypto.createHash('sha256').update(`${keyId ?? ''}:${source}`, 'utf8').digest('hex').slice(0, 32);
}

export function createPoolScheduler({
  name,
  accounts = [],
  settings = {},
  settingsFile,
  rng = Math.random,
  now = Date.now,
  quotaRatio,
} = {}) {
  let current = { ...DEFAULT_SETTINGS };
  for (const key of SETTING_KEYS) {
    if (!(key in settings)) continue;
    const clamped = clampSetting(key, settings[key]);
    if (clamped !== undefined) current[key] = clamped;
  }

  function runtimeOf(account, index = 0) {
    return {
      ...account,
      id: account.id ?? `${name ?? 'pool'}:${index}`,
      manualWeight: clampManual(account.manualWeight ?? DEFAULT_MANUAL_WEIGHT),
      enabled: account.enabled !== false && account.enabled !== 0,
      state: account.state ?? 'ok',
      inFlight: 0,
      cooldownUntil: 0,
      cooldownKind: null,
      consecutiveFails: 0,
      lastUsedAt: account.lastUsedAt ?? 0,
      outcomes: [],
    };
  }

  const runtime = accounts.map((account, index) => runtimeOf(account, index));

  /** key → { accId, expiresAt }：按 id 保存，updateAccount 重建对象后粘性仍有效。 */
  const sticky = new Map();

  function ratioOf(acc) {
    let value;
    try {
      value = quotaRatio ? quotaRatio(acc) : acc.quotaRatio;
    } catch {
      value = null;
    }
    return clampRatio(value);
  }

  function weightOf(acc, peers = runtime) {
    const own = ratioOf(acc);
    let quotaFactor;
    if (own !== null) {
      quotaFactor = own * 10;
    } else {
      // null 不惩罚：借用候选集中已知额度的均值；一个已知值都没有就按 0（彼此相等）
      const known = peers.map(ratioOf).filter((ratio) => ratio !== null);
      quotaFactor = known.length ? (known.reduce((sum, ratio) => sum + ratio, 0) / known.length) * 10 : 0;
    }
    const idleHours = acc.lastUsedAt ? Math.max(0, (now() - acc.lastUsedAt) / 3_600_000) : NEVER_USED_HOURS;
    const idleBonus = Math.min(idleHours * 0.5, 5);
    const outcomes = acc.outcomes || [];
    const rate = outcomes.length ? outcomes.reduce((sum, ok) => sum + ok, 0) / outcomes.length : 0;
    const successFactor = rate * 3;
    return (quotaFactor + idleBonus + successFactor) * acc.manualWeight;
  }

  function successRateOf(acc) {
    const outcomes = acc.outcomes || [];
    return outcomes.length ? outcomes.reduce((sum, ok) => sum + ok, 0) / outcomes.length : 0;
  }

  function recordOutcome(acc, ok) {
    acc.outcomes.push(ok ? 1 : 0);
    if (acc.outcomes.length > SUCCESS_WINDOW) acc.outcomes.splice(0, acc.outcomes.length - SUCCESS_WINDOW);
  }

  function cooldownFor(kind, fails) {
    if (kind === 'blocked') return current.blockedCooldownMs;
    if (kind === 'rate_limit') return fails >= 2 ? current.quotaCooldownMs : current.busyCooldownMs;
    if (kind === 'server') return current.serverCooldownMs;
    if (kind === 'quota_exhausted' || kind === 'quota') return current.quotaExhaustedCooldownMs;
    return 0;
  }

  function eligible(candidates, exclude) {
    return candidates.filter((acc) => {
      if (!acc.enabled || acc.manualWeight <= 0 || acc.state !== 'ok') return false;
      return !(exclude?.has(acc) || exclude?.has(acc.id));
    });
  }

  function weightedPick(candidates) {
    if (!candidates.length) return null;
    const scored = candidates
      .map((acc) => ({ acc, weight: weightOf(acc, candidates) }))
      .sort((a, b) => b.weight - a.weight);
    const top = scored.slice(0, Math.max(1, current.topN));
    const total = top.reduce((sum, item) => sum + item.weight, 0);
    // 全零权重时排序没有意义：在全部候选里等权随机，而不是钉在 top-N 的某一个
    if (total <= 0) return candidates[Math.floor(rng() * candidates.length)];
    let roll = rng() * total;
    for (const item of top) {
      roll -= item.weight;
      if (roll < 0) return item.acc;
    }
    return top[top.length - 1].acc;
  }

  /**
   * 选号。默认允许“最早恢复者”兜底（文档 §6.2）；exclude 内的账号绝不重试。
   * allowFallback=false 时无可用账号直接返回 null（调用方据此抛 429）。
   */
  function pick({ exclude = new Set(), allowFallback = true } = {}) {
    const t = now();
    const pool = eligible(runtime, exclude);
    const ready = pool.filter((acc) => acc.cooldownUntil <= t && acc.inFlight < current.maxInFlight);
    if (ready.length) return weightedPick(ready);
    if (!allowFallback) return null;
    const cooling = pool
      .filter((acc) => acc.cooldownUntil > t && acc.inFlight < current.maxInFlight)
      .sort((a, b) => a.cooldownUntil - b.cooldownUntil);
    return cooling[0] ?? null;
  }

  function onSuccess(acc) {
    acc.state = 'ok';
    acc.consecutiveFails = 0;
    acc.cooldownUntil = 0;
    acc.cooldownKind = null;
    acc.lastUsedAt = now();
    recordOutcome(acc, true);
  }

  function onUpstreamError(acc, cls = {}) {
    const kind = cls.kind || 'client';
    if (kind === 'auth') acc.state = 'needs_login';
    acc.consecutiveFails += 1;
    recordOutcome(acc, false);
    let cooldown = cooldownFor(kind, acc.consecutiveFails);
    if (kind !== 'auth' && kind !== 'client' && acc.consecutiveFails >= current.breakerThreshold) {
      const breaker = Math.min(
        current.breakerCooldownMs * 2 ** (acc.consecutiveFails - current.breakerThreshold),
        current.breakerCapMs,
      );
      cooldown = Math.max(cooldown, breaker);
    }
    // 冷却只增不减：短冷却（含 0）绝不能抹掉还在生效的长冷却
    acc.cooldownUntil = Math.max(acc.cooldownUntil, now() + cooldown);
    acc.cooldownKind = kind;
    return acc.cooldownUntil;
  }

  function stickyGet(key, { readyOnly = false } = {}) {
    const entry = sticky.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= now()) {
      sticky.delete(key);
      return null;
    }
    const acc = runtime.find((a) => a.id === entry.accId) ?? null;
    if (!acc) {
      sticky.delete(key);
      return null;
    }
    if (
      readyOnly &&
      (!acc.enabled ||
        acc.manualWeight <= 0 ||
        acc.state !== 'ok' ||
        acc.cooldownUntil > now() ||
        acc.inFlight >= current.maxInFlight)
    ) {
      return null;
    }
    entry.expiresAt = now() + current.stickyTtlMs; // 命中即续期
    return acc;
  }

  function stickySet(key, acc) {
    if (!key || !acc) return;
    if (sticky.size > 1000) {
      const t = now();
      for (const [k, v] of sticky) if (v.expiresAt <= t) sticky.delete(k);
    }
    sticky.set(key, { accId: acc.id, expiresAt: now() + current.stickyTtlMs });
  }

  function stickyClear(key) {
    if (key) sticky.delete(key);
  }

  /**
   * 原地改同一个运行态对象（保持对象身份）：send() 持有的引用在编辑后仍然有效，
   * inFlight / consecutiveFails / outcomes / lastUsedAt / 冷却等运行状态一律不动。
   * id 不可变；state 默认保留旧值，patch 里带了才更新。
   */
  function updateAccount(id, patch = {}) {
    const acc = runtime.find((item) => item.id === id);
    if (!acc) return null;
    const next = { ...patch };
    if ('manualWeight' in next) next.manualWeight = clampManual(next.manualWeight);
    if ('enabled' in next) next.enabled = next.enabled !== false && next.enabled !== 0;
    Object.assign(acc, next, { id: acc.id });
    return acc;
  }

  function snapshot() {
    return runtime.map((acc) => ({
      id: acc.id,
      label: acc.label ?? '',
      enabled: acc.enabled,
      state: acc.state,
      manualWeight: acc.manualWeight,
      inFlight: acc.inFlight,
      cooldownUntil: acc.cooldownUntil,
      cooldownRemainingMs: Math.max(0, acc.cooldownUntil - now()),
      cooldownKind: acc.cooldownKind,
      consecutiveFails: acc.consecutiveFails,
      successRate: successRateOf(acc),
      weight: weightOf(acc),
      lastUsedAt: acc.lastUsedAt,
      quotaRatio: ratioOf(acc),
    }));
  }

  function soonestRecovery() {
    const times = runtime
      .filter((acc) => acc.enabled && acc.manualWeight > 0 && acc.state === 'ok')
      .map((acc) => acc.cooldownUntil);
    return times.length ? Math.min(...times) : now();
  }

  /** 429 文案需要的可用性快照：区分“冷却中”和“并发打满”。 */
  function unavailableInfo() {
    const t = now();
    const pool = eligible(runtime, new Set());
    const cooling = pool.filter((acc) => acc.cooldownUntil > t);
    const ready = pool.filter((acc) => acc.cooldownUntil <= t);
    return {
      pool: pool.length,
      cooling: cooling.length,
      saturated: ready.length > 0 && ready.every((acc) => acc.inFlight >= current.maxInFlight),
      soonestRecovery: cooling.length ? Math.min(...cooling.map((acc) => acc.cooldownUntil)) : 0,
    };
  }

  function patchSettings(patch = {}) {
    current = persistSettings({ file: settingsFile, settings: current, patch });
    return { ...current };
  }

  return {
    name,
    accounts: runtime,
    pick,
    weightOf,
    successRateOf,
    onSuccess,
    onUpstreamError,
    stickyGet,
    stickySet,
    stickyClear,
    updateAccount,
    snapshot,
    soonestRecovery,
    unavailableInfo,
    patchSettings,
    now,
    get settings() {
      return { ...current };
    },
  };
}
