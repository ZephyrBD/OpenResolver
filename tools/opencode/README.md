# ugw-pool-balance

OpenCode v2 TUI 插件：在侧边栏常驻显示 OpenResolver 统一网关各池子的余额。

效果示例（侧边栏 `Pools` 区块，逐池一行，剩余进度条 + 可用量/总量）：

```text
Pools
Z [████████░░] 1.2B/2.0B
T [░░░░░░░░] 335/2.6K
W [██░░░░░░░░] 166M/1.0B cr
CA [████████░] 4.6K/4.6K cr
```

- 池名缩写：zcode→Z、trae→T、workbuddy→W、qoder→Q、codearts→CA，未知池名按分段取首字母。
- 进度条固定宽度（`barWidth`，默认 8），`█` 表示已用、`░` 表示剩余，ratio = balance/total，clamp 到 [0,1]。
- 数字人类可读：K/M/B/T/P，最多两位小数并去尾零（1.2e9→1.2B、166e6→166M、999→999、1.234e12→1.23T）；非有限值兜底为 "0"，不出现科学计数法或 Infinity。
- `unit: "credit"` 的池子比值后带 ` cr` 后缀，token 池不加。
- 标红（主题 error 色）：ratio ≤ `warnRatio`（默认 0.1），或存在不可用账号（`ok < accounts`）；正常用 muted 色。
- `total` 为 null 的池子（上游拿不到任何总量）退化为只显示可用量：`Z 1.2B`，无进度条无 `/total`。
- 请求失败时静默保留上次数据；从未拿到数据则显示 `gw?` 占位（后跟最多 40 字符的错误摘要）。

## 安装

1. 把整个 `ugw-pool-balance` 目录拷到 `~/.config/opencode/plugins/` 下：

   ```text
   ~/.config/opencode/plugins/ugw-pool-balance/package.json
   ~/.config/opencode/plugins/ugw-pool-balance/src/index.mjs
   ~/.config/opencode/plugins/ugw-pool-balance/src/tui.tsx
   ```

2. 在 **`~/.config/opencode/cli.json`** 的 `plugins` 数组注册（`package` 写插件目录，`options` 为该插件的配置）：

   ```json
   {
     "plugins": [
       {
         "package": "C:\\Users\\you\\.config\\opencode\\plugins\\ugw-pool-balance",
         "options": {
           "url": "https://your-gateway.example.com",
           "key": "zsk_xxxxxxxx",
           "intervalMs": 60000,
           "warnRatio": 0.1,
           "barWidth": 8
         }
       }
     ]
   }
   ```

   > **必须是 `cli.json`，不是 `tui.json`。** OpenCode 2.2.x 起 TUI 配置读的是
   > `~/.config/opencode/cli.json` 的 `plugins` 字段。`tui.json` 只在 `cli.json`
   > **不存在**时被一次性迁移过去；`cli.json` 一旦已存在，迁移逻辑只修 keybinds
   > 就提前返回，`tui.json` 里的 `plugin` 永远不会被读入。表现为插件能加载、
   > 但 `options` 全空（侧边栏显示 `ugw 配置缺失: url`）。
   >
   > `plugins` 里**没有** `plugin_enabled` 那种开关形式，每条就是
   > `{ package, options }`；`package` 可以是插件目录、包名或入口文件的绝对路径。

3. 重启 OpenCode（`cli.json` 与插件源码都不热重载）。

> 必须提供 `key`：插件不内置任何默认凭据。缺 `url` 会在侧边栏显示
> `ugw 配置缺失: url`，缺 `key` 显示 `ugw 配置缺失: key`（error 色），
> 这两种情况**不会发起请求**，也不会回落到任何写死的地址或密钥。
>
> 看到 `ugw 配置缺失: url` 基本可以直接判定为**配置放错了文件**（写进了
> `tui.json` 而不是 `cli.json`），而不是网关连不上。

> 插件形状：OpenCode v2（CLI ≥ 2.2.x）要求 TUI 插件默认导出为
> `{ id: "ugw-pool-balance", setup(context) { ... } }`，slot 通过
> `context.ui.slot({ append: "sidebar.content", render: () => <jsx/> })`
> 注册，`setup` 的返回值是插件停用/重载时执行的清理函数。
> 服务端入口 `src/index.mjs` 同样必须是 `{ id, setup }` 形状（空 setup 即可），
> 否则服务端加载报 `Plugin must export a default definition with an id and an
> effect or setup function`，整个插件标记为 failed。
> 旧的 `{ id, tui }` + `api.slots.register(...)` v1 形状会报
> `Invalid V2 TUI plugin module`。

## 配置项

| 项 | 必填 | 默认 | 说明 |
|---|---|---|---|
| `url` | 是 | — | 网关地址，如 `http://127.0.0.1:7860`（末尾 `/` 会自动去掉） |
| `key` | 是 | — | 网关 API key（`zsk_` 前缀），也可以用环境变量 `UGW_KEY` |
| `intervalMs` | 否 | `60000` | 轮询间隔（毫秒） |
| `warnRatio` | 否 | `0.1` | 剩余比例告警线：ratio = balance/total ≤ warnRatio 时该池整段标红 |
| `barWidth` | 否 | `8` | 进度条固定宽度（字符数） |

`url` 也可以用环境变量 `UGW_URL` 提供优先级：`cli.json` options > 环境变量。

## 鉴权

插件以 `Authorization: Bearer <key>` 调用网关的 `GET /v1/pool/balance`，key 就是你在 OpenCode 里配置的网关 `zsk_` key。网关只返回该 token 被授权的池子，所以不同 key 看到的池子列表可以不同。

响应里每个池子含 `balance`（剩余）与 `total`（同单位同口径的总量求和；上游拿不到任何 total 时为 `null`），进度条与 `x/y` 比值依赖 `total`，为 `null` 时退化为只显示可用量。

## 注意事项

- 轮询间隔不要小于 60 秒：余额接口会触发各账号 quota 回源，频繁轮询会放大对上游平台的请求压力。
- 取数用内置 `node:http`/`node:https` 直连而非 `fetch`：绕开宿主运行时的代理环境变量劫持 localhost、AbortSignal 缺失等环境差异。失败静默处理，不影响 TUI 正常使用。
- 渲染层只用最保守的元素集合（平级 `<text fg>` + `<Show>`/`<For>` 控制流）：Solid 组件体只运行一次且不被追踪，分支必须走 `<Show>`，否则数据到达后不会切换显示状态。
- 窄终端下侧边栏收起时不显示属正常。
- 服务端需升级到支持 `total` 字段的版本；旧版响应没有 `total` 时，所有池子都按 `total: null` 退化显示。
