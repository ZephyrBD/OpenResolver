import { toast } from '@/composables/useToast'

export function fmtTokens(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`
  return String(n)
}

export function fmtTime(ms?: number | null): string {
  if (!ms) return '—'
  return new Date(ms).toLocaleString('zh-CN', { hour12: false })
}

/** 池账号实体名称：标签 → 昵称 → 邮箱 → id（旧面板约定平移） */
export function accountName(acc?: { label?: string; nickname?: string; email?: string; id?: string }): string {
  return String(acc?.label || acc?.nickname || acc?.email || acc?.id || '')
}

/** `名称（id）`；名称即 id 时只显示一次 */
export function displayWithId(name?: string, id?: string): string {
  const primary = String(name || '')
  const secondary = String(id || '')
  return primary && secondary && primary !== secondary ? `${primary}（${secondary}）` : primary || secondary
}

export async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
    toast('已复制', 'success')
  } catch {
    toast('复制失败', 'error')
  }
}
