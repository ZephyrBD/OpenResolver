/** 菜单数据：路由注册与侧栏渲染的唯一来源（docs/frontend/05 §1）。 */
export interface MenuRecord {
  /** 路由路径，必须带端前缀 */
  path: string
  /** 路由名，端前缀 + 业务名大驼峰，全局唯一 */
  name: string
  /** 相对 src/view 的路径，不带 .vue */
  component: string
  title: string
  /** Element Plus 图标名 */
  icon: string
  order: number
  role: 'admin'
  hidden?: boolean
}

export const MENUS: MenuRecord[] = [
  {
    path: '/admin/dashboard',
    name: 'adminDashboard',
    component: 'admin/dashboard/index',
    title: '仪表盘',
    icon: 'Odometer',
    order: 1,
    role: 'admin',
  },
  {
    path: '/admin/accounts',
    name: 'adminAccounts',
    component: 'admin/accounts/index',
    title: '账号',
    icon: 'User',
    order: 2,
    role: 'admin',
  },
  {
    path: '/admin/keys',
    name: 'adminKeys',
    component: 'admin/keys/index',
    title: '密钥',
    icon: 'Key',
    order: 3,
    role: 'admin',
  },
  {
    path: '/admin/settings',
    name: 'adminSettings',
    component: 'admin/settings/index',
    title: '设置',
    icon: 'Setting',
    order: 4,
    role: 'admin',
  },
]
