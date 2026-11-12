<script setup lang="ts">
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import type { Component } from 'vue'
import { Key, Odometer, Setting, User } from '@element-plus/icons-vue'
import { MENUS } from '@/api/menu'
import { session } from '@/store/session'

const route = useRoute()
const router = useRouter()

const ICONS: Record<string, Component> = { Odometer, User, Key, Setting }

const items = computed(() =>
  [...MENUS]
    .sort((a, b) => a.order - b.order)
    .map((m) => ({
      name: m.name,
      path: m.path,
      title: m.title,
      icon: ICONS[m.icon],
    })),
)

// docs/frontend/06 §2 行式同构；el-menu 的行内缩进/激活实现触 CSP 裁定，改手写导航（登记组件清单）
function onSelect(name: string): void {
  void router.push({ name })
}

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
    <nav class="sidebar_nav" aria-label="主导航">
      <a
        v-for="item in items"
        :key="item.name"
        class="nav_item"
        :class="{ active: route.name === item.name }"
        :href="`#${item.path}`"
        :aria-current="route.name === item.name ? 'page' : undefined"
        @click.prevent="onSelect(item.name)"
      >
        <el-icon><component :is="item.icon" /></el-icon>
        <span>{{ item.title }}</span>
      </a>
    </nav>
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

.sidebar_nav {
  display: flex;
  flex-direction: column;
  gap: 4px;
  flex: 1;
}

.nav_item {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 42px;
  padding: 0 12px;
  border-radius: var(--radius-pill);
  color: var(--text-muted);
  font-weight: 500;
  transition: background-color 120ms ease, color 120ms ease;

  &:hover {
    color: var(--text);
    background: var(--bg-alt);
  }

  &.active {
    color: var(--accent-strong);
    background: var(--accent-10);
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

  .sidebar_nav {
    flex-direction: row;
    flex-wrap: wrap;
    flex: 0 0 auto;
  }

  .sidebar_foot {
    margin-top: 0;
    margin-left: auto;
  }
}
</style>
