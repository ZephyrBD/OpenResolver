<script setup lang="ts">
import { onMounted, watch } from 'vue'
import { useRoute } from 'vue-router'
import { session } from '@/store/session'
import AppSidebar from '@/components/layout/AppSidebar.vue'

const route = useRoute()

onMounted(() => {
  // 端级统一强调色（Design-md §1.3）：单管理端，固定 admin
  document.documentElement.dataset.accent = 'admin'
})

watch(
  () => session.isAuthenticated.value,
  (authed) => {
    document.body.classList.toggle('no_shell', !authed)
  },
  { immediate: true },
)
</script>

<template>
  <AppSidebar v-if="session.isAuthenticated.value && !route.meta.public" />
  <main class="app_main">
    <router-view />
  </main>
</template>

<style scoped lang="scss">
.app_main {
  padding: 24px 32px 48px;
  min-height: 100vh;
}

// 登录页全屏独占（无侧栏）
body.no_shell .app_main {
  padding: 0;
}
</style>

<style lang="scss">
// grid 壳挂 #app：aside/main 是 App.vue 的根级元素，body 与它们之间隔着 #app（docs/frontend/02 §7 全局结构类）
#app {
  display: grid;
  grid-template-columns: 220px 1fr;
  min-height: 100vh;
}

body.no_shell #app {
  display: block;
}

@media (max-width: 768px) {
  body:not(.no_shell) #app {
    grid-template-columns: 1fr;
    grid-template-rows: auto 1fr;
  }
}
</style>
