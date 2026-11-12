import { createRouter, createWebHashHistory, type RouteRecordRaw } from 'vue-router'
import { MENUS } from '@/api/menu'
import { session } from '@/store/session'
import ModulePlaceholder from '@/components/common/ModulePlaceholder.vue'

// 静态全量注册（docs/frontend/05 §3）：Batch 1 落地的页面用真实组件，
// 其余菜单页挂 ModulePlaceholder（docs/frontend/09 §4），后续批次按 menu.component 替换。
const menuRoutes: RouteRecordRaw[] = MENUS.map((m) => ({
  path: m.path,
  name: m.name,
  component: m.name === 'adminDashboard'
    ? () => import('@/view/admin/dashboard/index.vue')
    : m.name === 'adminAccounts'
      ? () => import('@/view/admin/accounts/index.vue')
      : ModulePlaceholder,
  meta: { title: m.title, role: m.role },
}))

const routes: RouteRecordRaw[] = [
  {
    path: '/login',
    name: 'login',
    component: () => import('@/view/common/login/index.vue'),
    meta: { public: true },
  },
  { path: '/admin', redirect: '/admin/dashboard' },
  ...menuRoutes,
  // fallback 兜底：未注册路径回端首页（docs/frontend/05 §3）
  { path: '/:pathMatch(.*)*', redirect: '/admin/dashboard' },
]

export const router = createRouter({
  history: createWebHashHistory(),
  routes,
})

router.beforeEach(async (to) => {
  if (to.meta.public) return true
  if (!session.isAuthenticated.value) {
    await session.loadMe()
  }
  return session.isAuthenticated.value ? true : { name: 'login', query: { from: to.fullPath } }
})
