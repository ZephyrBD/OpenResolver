/** @jsxImportSource @opentui/solid */
// OpenResolver 统一网关池余额 TUI 插件（OpenCode v2 形状）
// 侧边栏（sidebar.content）逐池一行显示剩余进度条与可用量/总量，如：
// Pools
// Z [████████░░] 1.2B/2.0B
// W [██░░░░░░░░] 166M/1.0B cr
//
// v2 插件形状依据（@opencode/cli 2.2.5 安装包反汇编）：
// - 加载器校验默认导出必须为 { id: 非空 string, setup: function }
// - setup(context) 返回值作为清理函数，插件停用/重载时执行
// - slot 注册用 context.ui.slot({ append: "sidebar.content", render: () => JSX })，
//   placement key 只能恰好填一个（prepend/append/before/after/replace）
// - Solid 组件体只运行一次且不被追踪：信号读取必须放在 <Show>/<For> 等
//   响应式控制流里，否则分支锁死在首渲染状态（"显示一下就没了"的根因）
// - 取数用 node:http 直连而非 fetch：绕开宿主运行时代理环境变量劫持
//   localhost、AbortSignal 缺失等环境差异
import { createSignal } from "solid-js"
import { Show, For } from "solid-js"
import type { RGBA } from "@opentui/core"
import type { IncomingMessage } from "node:http"
import * as http from "node:http"
import * as https from "node:https"

interface PoolBalance {
  name: string
  unit: "token" | "credit"
  balance: number
  /** 与 balance 同单位同口径的总量求和；上游拿不到任何 total 时为 null */
  total: number | null
  accounts: number
  ok: number
}

interface BalanceResponse {
  fetched_at: number
  pools: PoolBalance[]
}

// 最小化的 v2 setup context 类型（本地 @opencode-ai/plugin 1.17.18 的 d.ts 尚未收录 v2 形状，
// 类型以 2.2.5 宿主运行时为准，只声明本插件用到的字段）
interface V2SlotClaim {
  append?: string
  prepend?: string
  before?: string
  after?: string
  replace?: string
  render: (props: Record<string, unknown>) => unknown
}

interface V2Context {
  options?: Partial<Options>
  theme: { error: RGBA; textMuted: RGBA }
  ui: {
    slot(claim: V2SlotClaim): () => void
  }
}

interface Options {
  /** 网关地址，如 http://127.0.0.1:8790 */
  url: string
  /** 网关 zsk_ key */
  key: string
  /** 轮询间隔，毫秒，默认 60000，不建议小于 60s（接口会触发各账号 quota 回源） */
  intervalMs: number
  /** 剩余比例告警线：ratio = balance/total ≤ warnRatio 时标红，默认 0.1 */
  warnRatio: number
  /** 进度条固定宽度，默认 8 */
  barWidth: number
}

// 池名 → 展示缩写：zcode→Z, trae→T, workbuddy→W, qoder→Q, codearts→CA
const ABBR: Record<string, string> = {
  zcode: "Z",
  trae: "T",
  workbuddy: "W",
  qoder: "Q",
  codearts: "CA",
}

function abbrev(name: string): string {
  const n = name.toLowerCase()
  if (ABBR[n]) return ABBR[n]
  // 未知池名兜底：分段各取首字母大写（如 my-pool → MP），单段取首字母
  const parts = n.split(/[^a-z0-9]+/).filter(Boolean)
  if (parts.length > 1) return parts.map((p) => p.charAt(0).toUpperCase()).join("")
  return n.charAt(0).toUpperCase() + n.slice(1)
}

/**
 * 人类可读数字：K/M/B/T/P，最多两位小数并去尾零；<1000 直接显示整数。
 * 非有限值（null/NaN/Infinity）兜底为 "0"，避免出现科学计数法或 Infinity。
 * 例：1.2e9 → "1.2B"、166e6 → "166M"、999 → "999"、1.234e12 → "1.23T"、
 *     1e15 → "1P"、3.456e15 → "3.46P"、1500 → "1.5K"、1234 → "1.23K"
 */
export function human(n: number): string {
  if (!Number.isFinite(n)) return "0"
  const abs = Math.abs(n)
  if (abs >= 1e15) return trim(n / 1e15) + "P"
  if (abs >= 1e12) return trim(n / 1e12) + "T"
  if (abs >= 1e9) return trim(n / 1e9) + "B"
  if (abs >= 1e6) return trim(n / 1e6) + "M"
  if (abs >= 1e3) return trim(n / 1e3) + "K"
  return String(Math.round(n))
}

// 保留最多两位小数并去尾零：1.234→"1.23"、1.2→"1.2"、166→"166"
function trim(v: number): string {
  return v.toFixed(2).replace(/0+$/, "").replace(/\.$/, "")
}

/**
 * 剩余进度条：ratio = balance/total，clamp 到 [0,1]；total 非法时返回 null（无进度条）。
 * 例：bar(1.2e9, 2e9, 8) → 8 格里填 4.8 → 四舍五入 5 格实心
 */
function bar(balance: number, total: number | null, width: number): string | null {
  if (total === null || !Number.isFinite(total) || total <= 0) return null
  const ratio = Math.min(1, Math.max(0, balance / total))
  const filled = Math.round(ratio * width)
  return "█".repeat(filled) + "░".repeat(width - filled)
}

/** node:http(s) GET + JSON 解析，10s 超时；不走 fetch 以避开代理环境变量与运行时差异 */
function getJson(target: URL, headers: Record<string, string>, timeoutMs = 10_000): Promise<BalanceResponse> {
  return new Promise((resolve, reject) => {
    const mod = target.protocol === "https:" ? https : http
    const req = mod.get(
      target,
      { headers, timeout: timeoutMs },
      (res: IncomingMessage) => {
        const chunks: Buffer[] = []
        res.on("data", (c: Buffer) => chunks.push(c))
        res.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8")
          if (res.statusCode !== 200) {
            reject(new Error(`HTTP ${res.statusCode}`))
            return
          }
          try {
            resolve(JSON.parse(body) as BalanceResponse)
          } catch {
            reject(new Error("bad json"))
          }
        })
      },
    )
    req.on("timeout", () => req.destroy(new Error("timeout")))
    req.on("error", reject)
  })
}

async function setup(context: V2Context): Promise<() => void> {
  // 配置优先级：cli.json 中 plugins[].options > 环境变量 UGW_URL / UGW_KEY
  // 绝不内置凭据：key 缺失时明确报错，不回落到任何写死的值
  const opt = context.options ?? {}
  const base = (opt.url || process.env.UGW_URL || "").replace(/\/+$/, "")
  const key = opt.key || process.env.UGW_KEY || ""
  const intervalMs = opt.intervalMs && opt.intervalMs > 0 ? opt.intervalMs : 60_000
  const warnRatio = typeof opt.warnRatio === "number" ? opt.warnRatio : 0.1
  const barWidth = opt.barWidth && opt.barWidth > 0 ? Math.floor(opt.barWidth) : 8

  const [pools, setPools] = createSignal<PoolBalance[]>([])
  const [failed, setFailed] = createSignal(
    !base ? "配置缺失: url" : !key ? "配置缺失: key" : "",
  )
  let timer: ReturnType<typeof setInterval> | undefined

  async function fetchOnce() {
    // 缺 url/key 时不发请求：直接显示配置错误，避免误报成连接失败
    if (!base || !key) return
    try {
      const target = new URL(`${base}/v1/pool/balance`)
      const data = await getJson(target, { Authorization: `Bearer ${key}` })
      setPools(Array.isArray(data.pools) ? data.pools : [])
      setFailed("")
    } catch (e) {
      // 静默失败：保留上次数据；从未拿到数据时侧边栏显示 gw? + 错误摘要
      setFailed(e instanceof Error ? e.message : String(e))
    }
  }

  void fetchOnce()
  timer = setInterval(() => void fetchOnce(), intervalMs)

  // 每个池子一段：有 total 时 "X [██░░] 1.2B/2.0B"，无 total 退化 "X 1.2B"
  function partOf(p: PoolBalance): { label: string; bad: boolean } {
    const credit = p.unit === "credit" ? " cr" : ""
    const avail = `${human(p.balance)}${credit}`
    const b = bar(p.balance, p.total, barWidth)
    const bad = b === null
      ? p.balance <= 0 || p.ok < p.accounts
      : p.balance / Math.max(p.total!, 1) <= warnRatio || p.ok < p.accounts
    const label = b === null
      ? `${abbrev(p.name)} ${avail}`
      : `${abbrev(p.name)} [${b}] ${avail}/${human(p.total!)}${credit}`
    return { label, bad }
  }

  function PoolText(props: { p: PoolBalance }) {
    const info = () => partOf(props.p)
    return (
      <text fg={info().bad ? context.theme.error : context.theme.textMuted}>
        {info().label}
      </text>
    )
  }

  // 侧边栏布局：标题行 + 每池一行（竖排）。
  // 信号读取必须放在 Show/For 的响应式表达式里，分支才不会锁死在首渲染状态
  // 配置缺失是部署错误而非网络抖动：用 error 色并给出明确文案，不伪装成 gw?
  const configBroken = () => !base || !key

  function SidebarView() {
    return (
      <Show
        when={pools().length > 0}
        fallback={
          <Show when={failed()}>
            <text fg={configBroken() ? context.theme.error : context.theme.textMuted}>
              {configBroken() ? `ugw ${failed()}` : `gw? ${failed().slice(0, 40)}`}
            </text>
          </Show>
        }
      >
        <box flexDirection="column">
          <text fg={context.theme.textMuted}>Pools</text>
          <For each={pools()}>{(p) => <PoolText p={p} />}</For>
        </box>
      </Show>
    )
  }

  // v2 注册方式：ui.slot({ append, render })，返回值是反注册函数。
  // 窄终端下侧边栏收起时不显示属正常
  context.ui.slot({ append: "sidebar.content", render: () => <SidebarView /> })

  // setup 返回值即清理函数：插件停用/重载时由宿主执行
  return () => {
    if (timer) clearInterval(timer)
  }
}

export default {
  id: "ugw-pool-balance",
  setup,
}
