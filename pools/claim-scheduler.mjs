import fs from 'node:fs';
import path from 'node:path';
import { loadSettings } from './settings.mjs';

/**
 * 自动领取调度器：
 * - 每分钟 tick 一次；北京时间在签到窗口 [autoClaimStartHour, autoClaimEndHour) 内（默认 19:00–23:59），
 *   对「当天尚未成功」的账号按 pool × account 逐个重试，重试间隔 CLAIM_RETRY_GAP_MS；
 * - 已成功（claimed/already）或遇到不可重试失败（detail.retryable === false：凭证失效、验证码）
 *   的账号当天不再打上游；
 * - ZCode 周末活动包抢领：weekendGrabEnabled 且周五 18:00～周日 24:00（北京时间）内，
 *   每 30 分钟对 zcode 池强制跑一轮（不受当天成功状态限制）；
 * - 状态落 data/claims-state.json（按北京日期分桶，只保留最近若干天）；结果落 data/claims.json。
 * 单账号失败不影响其它账号；claimer.run() 保证不抛。
 */

const TICK_MS = 60_000;
const WEEKEND_GRAB_GAP_MS = 30 * 60_000;
const CLAIM_RETRY_GAP_MS = 30 * 60_000;
const MAX_LOG = 500;
const STATE_KEEP_DAYS = 7;

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** 北京时间（UTC+8 固定偏移）的 {date:'YYYY-MM-DD', hour, minute, weekday}。 */
export function beijingNow(ms = Date.now()) {
  const d = new Date(ms + 8 * 3600_000);
  return {
    date: d.toISOString().slice(0, 10),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
    weekday: d.getUTCDay(),
  };
}

/** 周五 18 点后 / 周六全天 / 周日 24 点前（北京时间）。 */
export function inWeekendWindow(bj = beijingNow()) {
  return (bj.weekday === 5 && bj.hour >= 18) || bj.weekday === 6 || bj.weekday === 0;
}

/** 签到窗口：[start, end) 小时，end 可到 24 表示当天末。 */
export function inClaimWindow(bj = beijingNow(), settings = {}) {
  const start = Number(settings.autoClaimStartHour ?? 0);
  const end = Number(settings.autoClaimEndHour ?? 0);
  return bj.hour >= start && bj.hour < end;
}

/**
 * 只有「失败了且没被标记不可重试」才值得在窗口内再来一次。
 * 凭证失效（401）、验证码（3007/3001）、凭证不可用等在 claimer 里会带 detail.retryable === false。
 */
export function isRetryableFailure(result) {
  return result?.status === 'failed' && result?.detail?.retryable !== false;
}

/** 当天结论已定：领到了、已领过、没活动、或不可重试失败。 */
export function isSettled(result) {
  if (!result) return false;
  return result.status === 'claimed' || result.status === 'already' || result.status === 'none' || !isRetryableFailure(result);
}

export function createClaimScheduler({
  pools = [],
  claimers = {},
  settingsFile,
  dataDir,
  log = () => {},
  now = Date.now,
  tickMs = TICK_MS,
  retryGapMs = CLAIM_RETRY_GAP_MS,
} = {}) {
  const logFile = path.join(dataDir, 'claims.json');
  const stateFile = path.join(dataDir, 'claims-state.json');
  let running = false;

  function appendLog(entries) {
    const prev = readJson(logFile, { entries: [] });
    const all = [...(prev.entries ?? []), ...entries].slice(-MAX_LOG);
    writeJson(logFile, { entries: all });
  }

  function loadState() {
    const st = readJson(stateFile, {});
    return st && typeof st === 'object' ? { ...st, days: st.days ?? {} } : { days: {} };
  }

  /** 只保留最近 STATE_KEEP_DAYS 天，避免状态文件无限长。 */
  function saveState(state) {
    const dates = Object.keys(state.days).sort();
    for (const d of dates.slice(0, Math.max(0, dates.length - STATE_KEEP_DAYS))) delete state.days[d];
    writeJson(stateFile, state);
  }

  function toEntry(pool, acc, result) {
    return {
      at: now(),
      pool: pool.name,
      account: acc.id,
      status: result.status,
      credits: result.credits ?? 0,
      claimed: result.claimed ?? [],
      message: result.message ?? '',
    };
  }

  async function claimAccount(pool, claimer, acc) {
    if (acc.enabled === false || acc.state === 'needs_login') return null;
    let result;
    try {
      result = await claimer.run(acc);
    } catch (err) {
      result = { ok: false, status: 'failed', claimed: [], credits: 0, message: err?.message || String(err) };
    }
    // 领取可能改变了额度/签到：清该账号 quota 缓存，额度明细下次 get 立刻回源
    pool?.quota?.invalidate?.(acc);
    return { result, entry: toEntry(pool, acc, result) };
  }

  /** 全量一轮：所有池 × 所有账号；skip 决定哪些账号本轮跳过（返回 reason 表示跳过）。 */
  async function runAll({ skip } = {}) {
    const entries = [];
    for (const pool of pools) {
      const claimer = claimers[pool.name];
      if (!claimer) continue;
      for (const acc of pool.accounts ?? []) {
        if (skip && skip(pool, acc)) continue;
        const out = await claimAccount(pool, claimer, acc);
        if (!out) continue;
        entries.push(out.entry);
        if (skip?._record) skip._record(pool, acc, out.result);
      }
    }
    if (entries.length) appendLog(entries);
    const claimed = entries.filter((e) => e.status === 'claimed').length;
    if (entries.length) log(`[auto-claim] 本轮领取：${entries.length} 账号，新领取 ${claimed}，其余见 claims.json`);
    return entries;
  }

  /** 周末抢领：只跑 zcode，不受当天成功状态限制。 */
  async function weekendGrab() {
    const claimer = claimers.zcode;
    const pool = pools.find((p) => p.name === 'zcode');
    if (!claimer || !pool) return;
    const entries = [];
    for (const acc of pool.accounts ?? []) {
      const out = await claimAccount(pool, claimer, acc);
      if (out) entries.push(out.entry);
    }
    if (entries.length) appendLog(entries);
    const grabbed = entries.filter((e) => e.status === 'claimed');
    if (grabbed.length) log(`[weekend-grab] 抢领成功 ${grabbed.length} 个：${grabbed.map((e) => `${e.account}(${e.claimed.join(',')})`).join(' ')}`);
  }

  function tick() {
    if (running) return;
    running = true;
    (async () => {
      try {
        const settings = loadSettings({ file: settingsFile, env: {} });
        const state = loadState();
        const bj = beijingNow(now());
        const today = (state.days[bj.date] ??= {});
        const record = (pool, acc, result) => {
          const bucket = (today[pool.name] ??= {});
          bucket[acc.id] = { lastStatus: result?.status ?? 'failed', lastAt: now(), retryable: isRetryableFailure(result) };
        };
        let dirty = false;

        if (settings.autoClaimEnabled && inClaimWindow(bj, settings)) {
          const skip = (pool, acc) => {
            if (acc.enabled === false || acc.state === 'needs_login') return true;
            const prev = today[pool.name]?.[acc.id];
            if (!prev) return false; // 今天还没跑过
            if (!prev.retryable) return true; // 已成功 / 已领过 / 无活动 / 不可重试失败
            return now() - (prev.lastAt ?? 0) < retryGapMs; // 间隔未到
          };
          skip._record = record;
          await runAll({ skip });
          dirty = true;
        }

        if (settings.weekendGrabEnabled && inWeekendWindow(bj) && now() - (state.lastWeekendGrabAt ?? 0) > WEEKEND_GRAB_GAP_MS) {
          state.lastWeekendGrabAt = now();
          dirty = true;
          await weekendGrab();
        }

        if (dirty) saveState(state);
      } catch (err) {
        log(`[auto-claim] tick 失败：${err?.message || err}`);
      } finally {
        running = false;
      }
    })();
  }

  return {
    tick,
    runAll: () => runAll(),
    start() {
      const settings = loadSettings({ file: settingsFile, env: {} });
      const timer = setInterval(tick, tickMs);
      if (timer.unref) timer.unref();
      log(
        `[auto-claim] 调度器已启动（每日北京时间 ${settings.autoClaimStartHour}:00–${settings.autoClaimEndHour === 24 ? '23:59' : `${settings.autoClaimEndHour}:00`} 窗口内每 ${Math.round(retryGapMs / 60_000)} 分钟补领）`,
      );
      return timer;
    },
  };
}
