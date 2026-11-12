export interface Overview {
  today: {
    requests: number
    errors: number
    inputTokens: number
    outputTokens: number
  }
  usageDegraded?: boolean
}

export interface PoolAccount {
  id: string
  label?: string
  quotaRatio?: number | null
}

export interface PoolSummary {
  name: string
  accounts: PoolAccount[]
}

export interface StatDay {
  date: string
  requests: number
  errors: number
}

export interface GatewayModel {
  id: string
  display_name?: string
  upstream_model?: string
  pool: string
  context_window: number | null
  supports_tools: boolean
  supports_thinking: boolean
  available?: boolean
}

export interface DashboardData {
  overview: Overview
  pools: PoolSummary[]
  stats: StatDay[]
  models: GatewayModel[]
}
