// headless 服务端入口：OpenCode v2 要求插件默认导出为 { id, setup }（或 { id, effect }），
// 否则服务端加载报 "Plugin must export a default definition with an id and an effect or setup function"，
// 且整个插件目标被标记为 failed。本插件逻辑全在 TUI 侧（./tui → src/tui.tsx），服务端保持空 setup。
// 依据：@opencode-ai/plugin 1.17.18 dist/v2/promise/plugin.d.ts
//   interface Plugin { readonly id: string; readonly setup: (context: PluginContext) => Promise<void> | void }
export default {
  id: "ugw-pool-balance",
  async setup() {},
}
