import { getJson, postJson, request } from '@/api/request'

export interface KeyRecord {
  id: string
  name?: string
  prefix: string
  enabledPools?: string[]
  expiresAt?: number
  createdAt?: number
  usedTokens?: number
  tokenQuota?: number
}

export interface CreatedKey {
  full: string
  key: KeyRecord
}

export async function fetchKeys(): Promise<KeyRecord[]> {
  const res = await getJson<{ keys: KeyRecord[] }>('/api/keys')
  return res.keys
}

export async function createKey(body: { name: string; pools: string[]; expiresAt?: number }): Promise<{ secret: string }> {
  return postJson<{ secret: string }>('/api/keys', body)
}

export async function rotateKey(id: string): Promise<{ secret: string }> {
  return postJson<{ secret: string }>(`/api/keys/${encodeURIComponent(id)}/rotate`)
}

export async function deleteKey(id: string): Promise<void> {
  await request.delete(`/api/keys/${encodeURIComponent(id)}`)
}

export interface KeyUsageStat {
  requests: number
  errors: number
  inputTokens: number
  outputTokens: number
  lastUsedAt: number
}

/** 密钥级用量聚合（缺省 14 天），keyId → 统计。无用量记录的 key 不在表内。 */
export async function fetchKeyUsage(days = 14): Promise<Record<string, KeyUsageStat>> {
  const res = await getJson<{ days: number; stats: Record<string, KeyUsageStat> }>(`/api/keys/usage`, { days })
  return res.stats
}
