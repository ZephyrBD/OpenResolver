/** 全站二次确认（ConfirmHost 提供，App.vue 挂载后可用）。 */
let impl: ((message: string, opts?: { danger?: boolean }) => Promise<boolean>) | null = null

export function registerConfirm(fn: NonNullable<typeof impl>): void {
  impl = fn
}

export function confirm(message: string, opts?: { danger?: boolean }): Promise<boolean> {
  if (!impl) return Promise.resolve(false)
  return impl(message, opts)
}
