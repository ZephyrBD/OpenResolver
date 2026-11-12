/** AppToast 宿主提供的消息 API（ElMessage 的 CSP 替代：ElMessage 会写内联 style 定位）。 */
export type ToastType = 'success' | 'error' | 'info'

interface ToastImpl {
  (message: string, type?: ToastType): void
}

let impl: ToastImpl | null = null

export function registerToast(fn: ToastImpl): void {
  impl = fn
}

export function toast(message: string, type: ToastType = 'info'): void {
  impl?.(message, type)
}
