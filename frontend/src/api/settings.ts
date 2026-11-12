import { getJson, request } from '@/api/request'

export interface PoolSettings {
  maxInFlight: number
  topN: number
  maxAttempts: number
  stickyTtlMs: number
  busyCooldownMs: number
  quotaCooldownMs: number
  blockedCooldownMs: number
  serverCooldownMs: number
  quotaExhaustedCooldownMs: number
  breakerThreshold: number
  breakerCooldownMs: number
  breakerCapMs: number
  autoClaimEnabled: number
  autoClaimHour: number
  weekendGrabEnabled: number
  wbCreditTokensRate: number
  qoderCreditTokensRate: number
  codeartsCreditTokensRate: number
  [key: string]: number
}

export async function fetchSettings(): Promise<PoolSettings> {
  const res = await getJson<{ settings: PoolSettings }>('/api/settings')
  return res.settings
}

export async function patchSettings(body: Record<string, number>): Promise<number> {
  const res = await request.patch<{ applied: number }>('/api/settings', body)
  return res.data.applied
}

export async function changePassword(body: { currentPassword: string; newPassword: string }): Promise<void> {
  await request.post('/auth/password', body)
}
