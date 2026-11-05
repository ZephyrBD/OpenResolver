import fs from 'node:fs';
import path from 'node:path';
import { fileSize } from './store.mjs';

/**
 * 用量记录（文档 §11）：按天分片 `usage/YYYY-MM-DD.jsonl`，行
 * `{ts, pool, model, keyId, status, inputTokens, outputTokens, cacheReadTokens, durationMs}`。
 * 记录是尽力而为：任何写入失败不影响推理响应；单文件超限停写并标 degraded。
 */

export const MAX_USAGE_FILE_BYTES = 64 * 1024 * 1024;
const EMPTY_TODAY = { requests: 0, errors: 0, inputTokens: 0, outputTokens: 0 };

/** UTC 日期（YYYY-MM-DD），与文件分片一致。 */
export function usageDate(ts) {
  return new Date(ts).toISOString().slice(0, 10);
}

export function usageFileFor(dataDir, date) {
  return path.join(dataDir, 'usage', `${date}.jsonl`);
}

export function createUsageRecorder({ dataDir, maxFileBytes = MAX_USAGE_FILE_BYTES, now = Date.now } = {}) {
  if (!dataDir) {
    // 无数据目录（如既有网关测试）：完全不启用。
    return {
      active: false,
      record() {},
      today: () => ({ ...EMPTY_TODAY }),
      series: () => [],
      get degraded() {
        return false;
      },
    };
  }
  const usageDir = path.join(dataDir, 'usage');
  let degradedFlag = false;

  function record(entry) {
    try {
      const ts = entry.ts ?? now();
      const file = usageFileFor(dataDir, usageDate(ts));
      if (fileSize(file) > maxFileBytes) {
        degradedFlag = true; // §11：超限停写，overview 标 degraded
        return;
      }
      const line = `${JSON.stringify({ ...entry, ts })}\n`;
      // 异步追加，失败不拖累请求
      fs.promises
        .mkdir(usageDir, { recursive: true, mode: 0o700 })
        .then(() => fs.promises.appendFile(file, line, { mode: 0o600 }))
        .catch(() => {});
    } catch {
      // 尽力而为
    }
  }

  function readDay(file) {
    let text = '';
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      return [];
    }
    return text
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  }

  function summarize(entries) {
    const sum = { requests: 0, errors: 0, inputTokens: 0, outputTokens: 0 };
    for (const e of entries) {
      sum.requests += 1;
      const status = typeof e.status === 'number' ? e.status : 500;
      if (status >= 400) sum.errors += 1;
      sum.inputTokens += e.inputTokens || 0;
      sum.outputTokens += e.outputTokens || 0;
    }
    return sum;
  }

  function today() {
    return summarize(readDay(usageFileFor(dataDir, usageDate(now()))));
  }

  /** 最近 days 天（含今天）的逐日聚合，缺数据的天补零。 */
  function series(days = 14) {
    const out = [];
    for (let i = days - 1; i >= 0; i--) {
      const ts = now() - i * 24 * 3_600_000;
      const date = usageDate(ts);
      out.push({ date, ...summarize(readDay(usageFileFor(dataDir, date))) });
    }
    return out;
  }

  return {
    active: true,
    record,
    today,
    series,
    get degraded() {
      return degradedFlag || fileSize(usageFileFor(dataDir, usageDate(now()))) > maxFileBytes;
    },
  };
}
