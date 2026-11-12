<script setup lang="ts">
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import type { Component } from 'vue'
import { Key, Odometer, Setting, User } from '@element-plus/icons-vue'
import { MENUS } from '@/api/menu'
import { session } from '@/store/session'

const route = useRoute()
const router = useRouter()

// docs/frontend/06 §2：el-menu-item 的 index 必须是真实路由名；
// 但 el-menu 的 router 模式把 index 当路径，这里手动按路由名跳转
function onSelect(name: string): void {
  void router.push({ name })
}

const ICONS: Record<string, Component> = { Odometer, User, Key, Setting }

const items = computed(() =>
  [...MENUS].sort((a, b) => a.order - b.order).map((m) => ({
    name: m.name,
    title: m.title,
    icon: ICONS[m.icon],
  })),
)

async function onLogout(): Promise<void> {
  await session.logout()
}
</script>

<template>
  <aside class="app_sidebar">
    <span class="brand">
      <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
        <circle cx="5" cy="9" r="4" fill="#0acf83" />
        <rect x="9" y="1" width="8" height="8" rx="3" fill="#1abcfe" />
        <circle cx="12" cy="13" r="4" fill="#a259ff" opacity="0.85" />
      </svg>
      Open-Resolver
    </span>
    <el-menu :default-active="route.name as string" class="sidebar_menu" @select="onSelect">
      <el-menu-item v-for="item in items" :key="item.name" :index="item.name">
        <el-icon><component :is="item.icon" /></el-icon>
        <span>{{ item.title }}</span>
      </el-menu-item>
    </el-menu>
    <div class="sidebar_foot">
      <el-button text class="logout_btn" @click="onLogout">登出</el-button>
    </div>
  </aside>
</template>

<style scoped lang="scss">
.app_sidebar {
  display: flex;
  flex-direction: column;
  gap: 20px;
  padding: 20px 16px;
  background: var(--bg);
  border-right: 1px solid var(--border);
  position: sticky;
  top: 0;
  height: 100vh;
  z-index: 10;
}

.brand {
  display: flex;
  align-items: center;
  gap: 10px;
  font-weight: 600;
  font-size: 17px;
  letter-spacing: -0.02em;
  padding: 0 8px;
}

.sidebar_menu {
  border-right: none;
  flex: 1;

  :deep(.el-menu-item) {
    height: 42px;
    line-height: 42px;
    border-radius: var(--radius-pill);
    margin: 2px 0;
  }

  :deep(.el-menu-item.is-active) {
    background: var(--accent-10);
    color: var(--accent-strong);
  }
}

.sidebar_foot {
  margin-top: auto;
}

.logout_btn {
  width: 100%;
  color: var(--text-muted);

  &:hover {
    color: var(--err);
  }
}

@media (max-width: 768px) {
  .app_sidebar {
    position: static;
    height: auto;
    flex-direction: row;
    flex-wrap: wrap;
    align-items: center;
    gap: 12px;
    padding: 12px 16px;
    border-right: none;
    border-bottom: 1px solid var(--border);
  }

  .sidebar_menu {
    flex-direction: row;
    display: flex;
    flex: 0 0 auto;

    :deep(.el-menu-item) {
      margin: 0 2px;
      padding: 0 12px;
    }
  }

  .sidebar_foot {
    margin-top: 0;
    margin-left: auto;
  }
}
</style>
