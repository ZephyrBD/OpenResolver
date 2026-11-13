/**
 * dispatch 编排公共件（03 §5 上提）：五池逐字拷贝的选号前奏、unavailable 错误、
 * Anthropic 收尾与 token patch 落盘。池保留真正有差异的中段（token 获取、payload
 * 构造、SSE 解码、错误分类细节）。
 */

import { HttpError } from '../http/errors.mjs';
import { loadAccounts, saveAccounts } from './zcode/accounts.mjs';
import path from 'node:path';

/**
 * 每次尝试的选号：首次尝试走粘性绑定，重试一律解绑（避免失败会话钉在同一账号）。
 * 返回 null 时调用方 `throw unavailable(lastError?.message)`。
 */
export function pickAttemptAccount(scheduler, stickyKey, attempt, tried) {
  let acc = null;
  if (stickyKey) {
    if (attempt === 0) {
      const bound = scheduler.stickyGet(stickyKey, { readyOnly: true });
      if (bound && !tried.has(bound.id)) acc = bound;
      else scheduler.stickyClear(stickyKey);
    } else {
      scheduler.stickyClear(stickyKey);
    }
  }
  if (!acc) acc = scheduler.pick({ exclude: tried, allowFallback: attempt > 0 });
  if (acc) tried.add(acc.id);
  return acc;
}

/** 全部账号不可用 / 并发饱和 → 429（label 为池显示名，进文案）。 */
export function unavailableError(scheduler, label, cause) {
  const info = scheduler.unavailableInfo();
  if (!info.pool) {
    return new HttpError(429, '没有可用账号，请检查账号状态', { type: 'rate_limit_error' });
  }
  if (!info.cooling && info.saturated) {
    return new HttpError(429, '当前并发已满，请稍后重试', { type: 'rate_limit_error' });
  }
  const waitMs = Math.max(0, (info.soonestRecovery || scheduler.soonestRecovery()) - scheduler.now());
  const suffix = cause ? `（最后错误：${cause}）` : '';
  return new HttpError(
    429,
    `所有 ${label} 账号暂不可用，约 ${Math.max(1, Math.ceil(waitMs / 60_000))} 分钟后恢复${suffix}`,
    { type: 'rate_limit_error' },
  );
}

/** Anthropic 事件聚合成功后的统一出口：channel 收尾 / 流式收尾 / collect 返回 / 非流式写 JSON。 */
export function finishAnthropicResponse({ res, collect, streaming, channel, events, toMessage }) {
  if (channel) {
    channel.end();
    return { status: 200, contentType: 'text/event-stream', events: channel };
  }
  if (streaming) {
    res.end();
    return;
  }
  const bodyText = JSON.stringify(toMessage(events));
  if (collect) return { status: 200, contentType: 'application/json', bodyText };
  res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(bodyText);
  return;
}

/** 流已开头后只能以 Anthropic error 事件收尾（不裸 destroy，客户端至少拿到可解析错误）。 */
export function writeAnthropicError(res, err) {
  res.write(`event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: err.type, message: err.message } })}\n\n`);
}

/** token patch 回写磁盘（日志前缀用池名）。accountsFile 未配置时为空操作。 */
export function tokenPatchPersister(accountsFile, logTag) {
  return (accId, patch) => {
    if (!accountsFile) return;
    try {
      const dir = path.dirname(accountsFile);
      const list = loadAccounts(dir);
      const row = list.find((a) => a.id === accId);
      if (!row) return;
      Object.assign(row, patch);
      saveAccounts(dir, list);
    } catch (err) {
      console.error(`[${logTag}] token patch 落盘失败（${accId}）：${err?.message}`);
    }
  };
}
