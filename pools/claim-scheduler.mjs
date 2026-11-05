import fs from 'node:fs';
import path from 'node:path';
import { loadSettings } from './settings.mjs';

/**
 * 自动领取调度器（M8d）：
 * - 每分钟 tick 一次；北京时间 [autoClaimHour, autoClaimHour+1) 内每个自然日只跑一轮全量领取；
 * - ZCode 周末活动包抢领：weekendGrabEnabled 且周五 18:00～周日 24:00（北京时间）内，
 *   每 30 分钟对 zcode 池跑一轮（claimer 自身按 kind 补缺，已领过不会重复打上游）；
 * - 结果落 data/claims.json（只存结论/积分/错误，绝不存凭证），滚动保留 500 条。
 * 单账号失败不影响其它账号；claimer.run() 保证不抛。
 */

const TICK_MS = 60_000;
const WEEKEND_GRAB_GAP_MS = 30 * 60_000;
const MAX_LOG = 500;

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

/** 北京时间（UTC+8 固定偏移）的 {date:'YYYY-MM-DD', hour, weekday}。 */
function beijingNow(ms = Date.now()) {
  const d = new Date(ms + 8 * 3600_000);
  const date = d.toISOString().slice(0, 10);
  return { date, hour: d.getUTCHours(), weekday: d.getUTCDay() };
}

/** 周五 18 点后 / 周六全天 / 周日 24 点前（北京时间）。 */
export function inWeekendWindow(bj = beijingNow()) {
  return (bj.weekday === 5 && bj.hour >= 18) || bj.weekday === 6 || bj.weekday === 0;
}

export function createClaimScheduler({
  pools = [],
  claimers = {},
  settingsFile,
  dataDir,
  log = () => {},
  now = Date.now,
  tickMs = TICK_MS,
} = {}) {
  const logFile = path.join(dataDir, 'claims.json');
  const stateFile = path.join(dataDir, 'claims-state.json');
  let running = false;

  function appendLog(entries) {
    const prev = readJson(logFile, { entries: [] });
    const all = [...(prev.entries ?? []), ...entries].slice(-MAX_LOG);
    writeJson(logFile, { entries: all });
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

  /** 全量领取：所有池 × 所有账号。返回写入日志的条目。 */
  async function runAll() {
    const entries = [];
    for (const pool of pools) {
      const claimer = claimers[pool.name];
      if (!claimer) continue;
      for (const acc of pool.accounts ?? []) {
        const entry = await claimAccount(pool, claimer, acc);
        if (entry) entries.push(entry);
      }
    }
    if (entries.length) appendLog(entries);
    const claimed = entries.filter((e) => e.status === 'claimed').length;
    log(`[auto-claim] 全量领取完成：${entries.length} 账号，新领取 ${claimed}，其余已领/无活动/失败见 claims.json`);
    return entries;
  }

  /** 周末抢领：只跑 zcode。 */
  async function weekendGrab() {
    const claimer = claimers.zcode;
    const pool = pools.find((p) => p.name === 'zcode');
    if (!claimer || !pool) return;
    const entries = [];
    for (const acc of pool.accounts ?? []) {
      const entry = await claimAccount(pool, claimer, acc);
      if (entry) entries.push(entry);
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
        const state = readJson(stateFile, {});
        const bj = beijingNow(now());

        if (settings.autoClaimEnabled && bj.hour === settings.autoClaimHour && state.lastFullClaimDate !== bj.date) {
          state.lastFullClaimDate = bj.date;
          writeJson(stateFile, state);
          await runAll();
        }

        if (settings.weekendGrabEnabled && inWeekendWindow(bj) && now() - (state.lastWeekendGrabAt ?? 0) > WEEKEND_GRAB_GAP_MS) {
          state.lastWeekendGrabAt = now();
          writeJson(stateFile, state);
          await weekendGrab();
        }
      } catch (err) {
        log(`[auto-claim] tick 失败：${err?.message || err}`);
      } finally {
        running = false;
      }
    })();
  }

  return {
    tick,
    runAll,
    start() {
      const timer = setInterval(tick, tickMs);
      if (timer.unref) timer.unref();
      log(`[auto-claim] 调度器已启动（每日北京时间 ${loadSettings({ file: settingsFile, env: {} }).autoClaimHour} 点全量补领）`);
      return timer;
    },
  };
}
