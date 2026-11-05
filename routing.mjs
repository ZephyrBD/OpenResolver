export class RouteError extends Error {
  constructor(message, status = 400, type = 'invalid_request_error') {
    super(message);
    this.name = 'RouteError';
    this.status = status;
    this.type = type;
  }
}

/**
 * 把 `<pool>/<model>` 切成池名与上游模型名。
 * 只按第一个 `/` 切，池名自带 `-` 也不受影响（v1 用最后一个 `-` 切是错的）。
 */
export function routeModel(id, poolNames) {
  if (typeof id !== 'string' || !id) {
    throw new RouteError('model 不能为空，格式必须是 <pool>/<model>');
  }
  const slash = id.indexOf('/');
  if (slash < 0) {
    throw new RouteError(`model 必须带池前缀，格式是 <pool>/<model>，可选前缀：${poolNames.join(', ')}`);
  }
  const pool = id.slice(0, slash);
  const model = id.slice(slash + 1);
  if (!poolNames.includes(pool)) {
    throw new RouteError(`未知的池前缀 "${pool}"，可选：${poolNames.join(', ')}`);
  }
  if (!model) {
    throw new RouteError(`"${pool}/" 缺少模型名`);
  }
  return { pool, model };
}
