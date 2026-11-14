import { getJson, postJson, request } from '@/api/request'

/** 池名清单（与网关 pools/* 一致，顺序即面板展示序） */
export const POOL_NAMES = ['zcode', 'qoder', 'qoder-cn', 'trae', 'workbuddy', 'workbuddy-cn', 'codearts'] as const
export type PoolName = (typeof POOL_NAMES)[number]

export interface PoolAccount {
  id: string
  label?: string
  nickname?: string
  email?: string
  enabled: boolean
  state: string
  consecutiveFails?: number
  manualWeight?: number | null
  cooldownUntil?: number
  cooldownKind?: string
}

export interface QuotaDetailLine {
  name: string
  remaining?: number
  total?: number
  unit?: string
  percent?: number | null
  kind?: string
}

export interface QuotaEntry {
  account: string
  label?: string
  ratio: number | null
  supported?: boolean
  reason?: string
  error?: string
  source?: string
  details?: QuotaDetailLine[]
  periodEnd?: number
  plan?: string
  checkin?: { checkedIn?: boolean; credits?: number; message?: string }
}

export interface ClaimResult {
  account: string
  label?: string
  status: string
  credits?: number
  message?: string
  claimed?: string[]
  detail?: { tried?: { planId?: string; code?: string; msg?: string }[] }
}

export interface OnboardAccount {
  id: string
  label?: string
  nickname?: string
  email?: string
}

export async function fetchAccounts(pool: string): Promise<PoolAccount[]> {
  const res = await getJson<{ accounts: PoolAccount[] }>(`/api/pools/${encodeURIComponent(pool)}/accounts`)
  return res.accounts
}

export async function patchAccount(pool: string, id: string, body: { label?: string; enabled: boolean; manualWeight: number }): Promise<void> {
  await request.patch(`/api/pools/${encodeURIComponent(pool)}/accounts/${encodeURIComponent(id)}`, body)
}

export async function resetAccount(pool: string, id: string): Promise<void> {
  await postJson(`/api/pools/${encodeURIComponent(pool)}/accounts/${encodeURIComponent(id)}/reset`)
}

export async function deleteAccount(pool: string, id: string): Promise<void> {
  await request.delete(`/api/pools/${encodeURIComponent(pool)}/accounts/${encodeURIComponent(id)}`)
}

export async function importAccount(pool: string, body: Record<string, unknown>): Promise<OnboardAccount> {
  return postJson<{ account: OnboardAccount }>(`/api/pools/${encodeURIComponent(pool)}/accounts`, body).then((r) => r.account)
}

export async function fetchQuota(pool: string): Promise<QuotaEntry[]> {
  const res = await getJson<{ accounts: QuotaEntry[] }>(`/api/pools/${encodeURIComponent(pool)}/quota`)
  return res.accounts
}

export async function claimPool(pool: string): Promise<ClaimResult[]> {
  const res = await postJson<{ results: ClaimResult[] }>(`/api/pools/${encodeURIComponent(pool)}/claim`, {})
  return res.results ?? []
}

export interface AccountCheckResult {
  ok: boolean
  source: 'live' | 'stale' | 'unknown'
  ratio: number | null
  error: string | null
}

/** 凭证检测：强制回源该账号额度（不消耗对话额度）。live=凭证有效。 */
export async function checkAccount(pool: string, id: string): Promise<AccountCheckResult> {
  return postJson(`/api/pools/${encodeURIComponent(pool)}/accounts/${encodeURIComponent(id)}/check`)
}

export interface ModelRefreshResult {
  refreshed: boolean
  degraded: number
  total: number
}

/** 模型目录手动刷新（静态表池返回 400，由调用方提示）。 */
export async function refreshPoolModels(pool: string): Promise<ModelRefreshResult> {
  return postJson(`/api/pools/${encodeURIComponent(pool)}/models/refresh`)
}
