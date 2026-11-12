import { getJson } from '@/api/request'
import type { GatewayModel, Overview, PoolSummary, StatDay } from '@/types/models'

interface ModelsResponse {
  data: GatewayModel[]
}

export async function fetchOverview(): Promise<Overview> {
  return getJson<Overview>('/api/overview')
}

export async function fetchPools(): Promise<PoolSummary[]> {
  const res = await getJson<{ pools: PoolSummary[] }>('/api/pools')
  return res.pools
}

export async function fetchStats(days = 14): Promise<StatDay[]> {
  const res = await getJson<{ stats: StatDay[] }>('/api/stats', { days })
  return res.stats ?? []
}

export async function fetchModels(): Promise<GatewayModel[]> {
  const res = await getJson<ModelsResponse>('/api/models')
  return res.data
}
