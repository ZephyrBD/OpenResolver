# 04 · HTTP 与错误规范

> 响应信封、错误码分段、`<pool>/<model>` 路由语义是**存量契约**（`AGENTS.md` `W4`）：只描述「当前应该怎么做」，任何"顺手统一"都属重决策（`A3`）。

## 1. 响应信封

- 成功：`sendJson(res, status, payload)`（`http/respond.mjs`）——统一带 `content-type: application/json; charset=utf-8`、`content-length`、`cache-control: no-store`。
- 错误：`apiError(status, message, type)` 产出 `{ error: { type, message } }` 信封。面板前端（`app.js` `api()`）按 `data.error.message` 取文案——**改信封结构会静默弄瞎面板**。

### 1.1 `type` 取值语义

| type | 语义 | 使用方 |
| --- | --- | --- |
| `invalid_request_error` | 请求体/参数不合法 | `HttpError` 默认、`RouteError` 默认 |
| `authentication_error` | 密钥缺失/无效/过期 | `AuthError` 默认 |
| `api_error` | 上游故障/网关内部错误 | `apiError` 默认 |

新增 type 属重决策；先用上表，不够再问。

## 2. 错误类

| 类 | 文件 | 必带 | 用途 |
| --- | --- | --- | --- |
| `HttpError` | `http/errors.mjs` | `status` / `type` / `code` | 通用 HTTP 错误 |
| `AuthError` | `auth/guard.mjs` | 同上（默认 `authentication_error`） | 鉴权链失败 |
| `RouteError` | `routing.mjs` | 同上（默认 `invalid_request_error`） | `<pool>/<model>` 解析失败 |

- 禁止裸 `throw new Error(...)` 穿透到端点处理层——没有 `status` 就无法产出正确信封。
- 错误 message 面向**面板与客户端排障**：写清「缺什么、可选值是什么」（`routeModel` 的错误文案即范例），不写堆栈内部术语。

## 3. 请求体

- 读取一律 `http/body.mjs` `readJson(req, maxBytes)`；上限 `DEFAULT_MAX_BODY_BYTES`（`config.mjs` 可经 `UGW_MAX_BODY_BYTES` 覆盖，默认 8MB）。
- 超限 / 非法 JSON / 非 POST body 的处理只在 `readJson` 内做一次，端点不重复实现。
- 新端点若需要不同上限，走 `config.mjs` 加配置项，不在端点内写死字面量。

## 4. 超时与断开

| 项 | 约定 | 落点 |
| --- | --- | --- |
| 上游总超时 | `config.upstreamTimeoutMs`（默认 600s），全部上游请求适用 | `boot.mjs` 组装时传入 |
| 客户端断开 | 客户端 `close` → 对上游 `abort`，不继续消耗订阅额度 | `gateway.mjs`（先例：`test/zcode.abort.test.js`） |
| SSE 流式 | 上游事件边收边透传，不整段缓存；解析用 `createSseParser` | `adapters/sse-reader.mjs` |

- 禁止「客户端已断仍跑完上游请求」——这是额度安全问题，不是性能问题。

## 5. 用量采集

- 响应体捕获走 `gateway.mjs` `tapResponse` 模式：**上限 1MB**，超限即放弃解析（truncated），不无界累积内存。
- usage 解析尽力而为：非流式取 `usage`（Anthropic/OpenAI 两套字段名都认），流式/不可解析填 0，**不猜、不推算**。

## 6. 客户端 IP

- `clientIp(req)` 只取 `req.socket.remoteAddress`；**忽略 `X-Forwarded-For`**（伪造面）。语义见 `07 §5`。
- IPv6 映射前缀 `::ffff:` 由 `normalizeIp` 统一剥除，CIDR 白名单判定走 `auth/guard.mjs` `ipAllowed()`。

## 7. 新增端点的完整步骤

1. 在 `gateway.mjs` `createGateway` 内注册处理函数（路由注册唯一来源，见 `05 §1`）。
2. 鉴权分界：推理面走 `authorize`，面板面走会话 + CSRF（`05 §2`），不得绕过。
3. 请求体走 `readJson`，响应走 `sendJson` / `apiError`（§1–§3）。
4. 需要池数据时经池能力，不直读 `data/` 文件。
5. `test/` 补 `<域>.<特性>.test.js`（`08 §2`）。

## 8. 相关文档

- [03-上游适配层规范](03-上游适配层规范.md)
- [05-路由与鉴权](05-路由与鉴权.md)
- [07-安全规范](07-安全规范.md)
