import axios from 'axios'

/** 唯一 HTTP 出口（docs/frontend/08 §1）：页面不直接调 axios。 */
export const request = axios.create({
  baseURL: '/',
  timeout: 30_000,
  withCredentials: true,
})

type ExpireHandler = () => void
let expireHandler: ExpireHandler | null = null

/** 登录态过期回调（session.ts 注册，避免 store ↔ request 循环依赖）。 */
export function onSessionExpire(handler: ExpireHandler): void {
  expireHandler = handler
}

request.interceptors.request.use((config) => {
  if (config.method && config.method !== 'get') {
    const token = csrfToken()
    if (token) config.headers['x-ugw-csrf'] = token
  }
  return config
})

request.interceptors.response.use(
  (res) => res,
  (err) => {
    const status = err.response?.status
    if (status === 401) expireHandler?.()
    const message = err.response?.data?.error?.message || `请求失败（HTTP ${status ?? 0}）`
    return Promise.reject(new ApiError(status ?? 0, message))
  },
)

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message)
  }
}

function csrfToken(): string {
  const pair = document.cookie.split(';').find((c) => c.trim().startsWith('ugw_csrf='))
  return pair ? pair.split('=').slice(1).join('=').trim() : ''
}

export async function getJson<T>(url: string, params?: Record<string, unknown>): Promise<T> {
  const res = await request.get<T>(url, { params })
  return res.data
}

export async function postJson<T>(url: string, body?: unknown): Promise<T> {
  const res = await request.post<T>(url, body)
  return res.data
}
