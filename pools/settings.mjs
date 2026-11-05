import fs from 'node:fs';
import path from 'node:path';

/**
 * 池调度参数（文档 §6 / §11 / §18）。
 * 文件 data/pool-settings.json 优先；环境变量只作首次默认值。
 */
export const DEFAULT_SETTINGS = Object.freeze({
  maxInFlight: 5,
  topN: 3,
  stickyTtlMs: 1_800_000,
  maxAttempts: 3,
  breakerThreshold: 3,
  blockedCooldownMs: 600_000,
  busyCooldownMs: 90_000,
  quotaCooldownMs: 1_800_000,
  serverCooldownMs: 60_000,
  breakerCooldownMs: 1_800_000, // 连犯熔断基数（原 base.mjs BREAKER_BASE_MS）
  breakerCapMs: 21_600_000, // 熔断封顶（原 BREAKER_CAP_MS）
  quotaExhaustedCooldownMs: 43_200_000, // 额度耗尽（原 QUOTA_EXHAUSTED_MS）
  autoClaimEnabled: 1, // 自动领取总开关（0/1）
  autoClaimHour: 9, // 每日补领时点（北京时间 0-23）
  weekendGrabEnabled: 1, // ZCode 周末活动包抢领（0/1）
  wbCreditTokensRate: 1.265, // WB credits→tokens：按 glm-5.2 倍率 x0.79 的倒数
  qoderCreditTokensRate: 1, // Qoder credit→tokens：默认 1:1
  codeartsCreditTokensRate: 1, // CodeArts credits→tokens：默认 1:1
});

/** 整数字段至少为 1；时长字段允许 0（= 不冷却）。 */
const MIN_ONE = new Set(['maxInFlight', 'topN', 'maxAttempts', 'breakerThreshold', 'breakerCooldownMs', 'breakerCapMs', 'quotaExhaustedCooldownMs']);
const BOOLEAN_KEYS = new Set(['autoClaimEnabled', 'weekendGrabEnabled']);
/** 浮点比率字段，下限 0.0001（0 表示"永远无余额"没有意义，极端场景一律地板值）。 */
const FLOAT_MIN = new Set(['wbCreditTokensRate', 'qoderCreditTokensRate', 'codeartsCreditTokensRate']);
const HOUR_MIN = 0;
const HOUR_MAX = 23;

const ENV_KEYS = {
  maxInFlight: 'UGW_MAX_INFLIGHT',
  topN: 'UGW_TOPN',
  stickyTtlMs: 'UGW_STICKY_TTL_MS',
  maxAttempts: 'UGW_MAX_ATTEMPTS',
  breakerThreshold: 'UGW_BREAKER_THRESHOLD',
  blockedCooldownMs: 'UGW_BLOCKED_COOLDOWN_MS',
  busyCooldownMs: 'UGW_BUSY_COOLDOWN_MS',
  quotaCooldownMs: 'UGW_QUOTA_COOLDOWN_MS',
  serverCooldownMs: 'UGW_SERVER_COOLDOWN_MS',
  breakerCooldownMs: 'UGW_BREAKER_COOLDOWN_MS',
  breakerCapMs: 'UGW_BREAKER_CAP_MS',
  quotaExhaustedCooldownMs: 'UGW_QUOTA_EXHAUSTED_COOLDOWN_MS',
  autoClaimEnabled: 'UGW_AUTO_CLAIM',
  autoClaimHour: 'UGW_AUTO_CLAIM_HOUR',
  weekendGrabEnabled: 'UGW_WEEKEND_GRAB',
  wbCreditTokensRate: 'UGW_WB_CREDIT_TOKENS_RATE',
  qoderCreditTokensRate: 'UGW_QODER_CREDIT_TOKENS_RATE',
  codeartsCreditTokensRate: 'UGW_CODEARTS_CREDIT_TOKENS_RATE',
};

export const SETTING_KEYS = Object.freeze(Object.keys(DEFAULT_SETTINGS));

/** 吸附到合法区间；非法值原样丢弃（由调用方决定是否保留旧值）。 */
export function clampSetting(key, value) {
  const n = typeof value === 'boolean' ? (value ? 1 : 0) : typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n)) return undefined;
  if (BOOLEAN_KEYS.has(key)) return n > 0 ? 1 : 0;
  if (key === 'autoClaimHour') return Math.min(HOUR_MAX, Math.max(HOUR_MIN, Math.floor(n)));
  if (FLOAT_MIN.has(key)) return Math.max(0.0001, n);
  if (MIN_ONE.has(key)) return Math.max(1, Math.floor(n));
  return Math.max(0, Math.floor(n));
}

function defaultsFromEnv(env = {}) {
  const settings = { ...DEFAULT_SETTINGS };
  for (const key of SETTING_KEYS) {
    const raw = env?.[ENV_KEYS[key]];
    if (raw === undefined || raw === '') continue;
    const clamped = clampSetting(key, raw);
    if (clamped !== undefined) settings[key] = clamped;
  }
  return settings;
}

function readFileSettings(file) {
  if (!file) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null; // 文件缺失 / 坏 JSON 都回退默认值，不抛
  }
}

/**
 * 读设置：默认值 → 环境变量 → 文件（文件逐字段覆盖）。
 * 文件损坏时静默回退到“默认值 + 环境变量”。
 */
export function loadSettings({ file, env = process.env } = {}) {
  const settings = defaultsFromEnv(env);
  const fromFile = readFileSettings(file);
  if (!fromFile) return settings;
  for (const key of SETTING_KEYS) {
    if (!(key in fromFile)) continue;
    const clamped = clampSetting(key, fromFile[key]);
    if (clamped !== undefined) settings[key] = clamped;
  }
  return settings;
}

/** 原子写：tmp + rename，权限 0o600。 */
export function writeSettings(file, settings) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  const payload = {};
  for (const key of SETTING_KEYS) payload[key] = settings[key];
  fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
  return payload;
}

/**
 * 合并补丁 → clamp → 落盘。返回新对象，不改入参。
 * 未提供的字段沿用当前值；未知字段忽略。
 */
export function patchSettings({ file, settings = DEFAULT_SETTINGS, patch = {} } = {}) {
  const next = { ...settings };
  for (const key of SETTING_KEYS) {
    if (!(key in patch)) continue;
    const clamped = clampSetting(key, patch[key]);
    if (clamped !== undefined) next[key] = clamped;
  }
  if (file) writeSettings(file, next);
  return next;
}
