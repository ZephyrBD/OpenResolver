// 6004 模型级限流注册表（PROTOCOL.md §111-128；插件行为 plugins/workbuddy/model_ratelimit.go）：
// - HTTP 429 + 业务码 6004 的 msg 自带声明式重置时刻（"将在 YYYY-MM-DD HH:mm:ss UTC+8 重置"），
//   语义是模型级限流——同凭证其它模型健康，绝不计入凭证级冷却；
// - 该 (账号, 模型) 后续请求快速失败（不打上游）直至声明时刻；解析失败退 1 分钟默认窗口，
//   绝不猜测长窗口；后续 6004 只延长、不缩短在持窗口；
// - 内存态即可，不落盘（窗口最长不过到当日重置点）。

/** 解析声明式重置时刻为毫秒时间戳（UTC+8）；无时间或解析失败退 now + 60s。 */
export function parseResetTime(msg, nowMs) {
  const m = /将在\s*(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})\s*UTC\+8/.exec(String(msg ?? ''));
  if (!m) return nowMs + 60_000;
  const [, y, mo, d, h, mi, s] = m;
  const ms = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)) - 8 * 3_600_000;
  if (!Number.isFinite(ms)) return nowMs + 60_000;
  return ms;
}

const keyOf = (accId, model) => `${accId}\u0000${model}`;

export function createRateLimitRegistry({ now = Date.now } = {}) {
  const map = new Map();

  /** 记录一次 6004：until = max(旧, 新)，返回生效的 until。 */
  function observe(accId, model, until) {
    const key = keyOf(accId, model);
    const prev = map.get(key) ?? 0;
    const next = Math.max(prev, Number(until) || 0);
    map.set(key, next);
    return next;
  }

  /** 该 (账号, 模型) 是否仍在限流窗口内：是返回 until，否则清理并返回 null。 */
  function fastFail(accId, model) {
    const key = keyOf(accId, model);
    const until = map.get(key);
    if (!until || until <= now()) {
      map.delete(key);
      return null;
    }
    return until;
  }

  function reset() {
    map.clear();
  }

  return { observe, fastFail, reset };
}

/** 上游 6004 文案 → 客户端错误消息（刻意不含字面 "429"，PROTOCOL.md §124）。 */
export function modelRateLimitMessage(model, until) {
  const d = new Date(until);
  const p = (n) => String(n).padStart(2, '0');
  // 按 UTC+8 声明时刻格式化为 YYYY-MM-DD HH:mm:ss（与上游 msg 文案同形）
  const t = new Date(d.getTime() + 8 * 3_600_000);
  const time = `${t.getUTCFullYear()}-${p(t.getUTCMonth() + 1)}-${p(t.getUTCDate())} ${p(t.getUTCHours())}:${p(t.getUTCMinutes())}:${p(t.getUTCSeconds())}`;
  return `模型 ${model} 触发上游频率限制，将于 ${time} UTC+8 重置，您也可以切换其他模型继续使用`;
}
