/**
 * 额度缓存骨架（五池共用，03 §5 上提）：TTL 缓存 + 失败退避（60s 起、翻倍、封顶）
 * + 同账号并发单飞 + peek/invalidate。池文件只提供「上游说了什么」：
 *
 * - `fetchOne(acc)`：回源并解析（失败抛错），返回值须含 `ratio`。
 * - `toResult(entry, source, error?)`：池对外结果形状。
 * - `isFresh(entry)`：缓存新鲜判定（默认 `ratio !== null && !error`；codearts 的
 *   `supported:false` 也是合法缓存态，覆写为 `!error`）。
 * - `staleSource(entry)`：退避窗口内的 source 标记（默认按 ratio 是否为 null）。
 * - `attempt(acc, key, helpers)`：覆写整个回源尝试（codearts 双路并行用）。
 *
 * 纪律（06 §6）：失败不静默归零——保留旧值标 stale；任何异常都只反映在返回值里，
 * 额度只是调度参考，绝不能让 send 失败。
 */

export function createQuotaCacheSkeleton({
  now = Date.now,
  ttlMs,
  backoffBaseMs,
  backoffMaxMs,
  entryKey = (acc) => String(acc?.id ?? acc?.uid ?? 'unknown'),
  fetchOne,
  toResult,
  isFresh = (entry) => entry.ratio !== null && !entry.error,
  staleSource = (entry) => (entry.ratio === null ? 'unknown' : 'stale'),
  errorOf = (err) => err?.message || '额度查询失败',
  /** 装饰性字段（签到展示等）回填：慢/失败不拖 ratio 主链路，异常被吞掉下次再试。 */
  afterFetch = null,
  attempt = null,
} = {}) {
  const cache = new Map();
  const inflight = new Map();
  const backoffFor = (failures) => Math.min(backoffBaseMs * 2 ** (failures - 1), backoffMaxMs);

  async function defaultAttempt(acc, key) {
    try {
      const parsed = await fetchOne(acc);
      const next = { ...parsed, fetchedAt: now(), error: null, failures: 0, nextAttemptAt: 0 };
      if (afterFetch) {
        try {
          Object.assign(next, (await afterFetch(next, acc)) ?? {});
        } catch {
          // 保留装饰字段的当前值，下次刷新再试
        }
      }
      cache.set(key, next);
      return toResult(next, 'live');
    } catch (err) {
      const previous = cache.get(key) ?? { ratio: null, fetchedAt: 0, failures: 0 };
      const failures = (previous.failures ?? 0) + 1;
      const next = { ...previous, error: errorOf(err), failures, nextAttemptAt: now() + backoffFor(failures) };
      cache.set(key, next);
      return toResult(next, staleSource(next), next.error);
    }
  }

  const attemptFn = attempt ?? defaultAttempt;

  async function get(acc) {
    const key = entryKey(acc);
    const t = now();
    const entry = cache.get(key);

    if (entry && isFresh(entry) && t - entry.fetchedAt < ttlMs) {
      return toResult(entry, 'live');
    }
    if (entry && entry.nextAttemptAt > t) {
      return toResult(entry, staleSource(entry), entry.error);
    }

    // 同一账号的并发查询共享一个请求，避免面板/调度同时回源把上游打爆
    const pending = inflight.get(key);
    if (pending) return pending;
    const promise = attemptFn(acc, key, { cache, now }).finally(() => inflight.delete(key));
    inflight.set(key, promise);
    return promise;
  }

  /** 同步读最近一次成功值，供调度器 quotaRatio 使用；无数据返回 null。 */
  function peek(acc) {
    const entry = cache.get(entryKey(acc));
    return typeof entry?.ratio === 'number' ? entry.ratio : null;
  }

  /** 领取成功后清缓存：按账号删 entry（连同退避计数），下个 get 即回源；无参全清。 */
  function invalidate(acc) {
    if (acc == null) {
      cache.clear();
      return;
    }
    cache.delete(entryKey(acc));
  }

  return { get, peek, invalidate };
}
