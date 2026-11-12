import { computed, reactive } from 'vue'
import { onSessionExpire, postJson, getJson } from '@/api/request'

interface MeResponse {
  authenticated: boolean
}

/** 登录态（运行态仅内存，刷新复位，docs/frontend/08 §3）。 */
const state = reactive({ authenticated: false })

async function loadMe(): Promise<void> {
  try {
    const me = await getJson<MeResponse>('/auth/me')
    state.authenticated = me.authenticated === true
  } catch {
    state.authenticated = false
  }
}

async function login(password: string): Promise<void> {
  await postJson('/auth/login', { password })
  state.authenticated = true
}

async function logout(): Promise<void> {
  try {
    await postJson('/auth/logout')
  } catch {
    // 会话可能已失效，照常回登录页
  }
  state.authenticated = false
}

function expire(): void {
  state.authenticated = false
}

onSessionExpire(expire)

const isAuthenticated = computed(() => state.authenticated)

export const session = { state, isAuthenticated, loadMe, login, logout, expire }
