<script setup lang="ts">
import { ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { session } from '@/store/session'

const route = useRoute()
const router = useRouter()

const password = ref('')
const loading = ref(false)
const error = ref('')

async function onSubmit(): Promise<void> {
  if (!password.value || loading.value) return
  loading.value = true
  error.value = ''
  try {
    await session.login(password.value)
    password.value = ''
    const from = typeof route.query.from === 'string' ? route.query.from : '/admin/dashboard'
    router.push(from)
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <div class="login_page">
    <form class="login_card" @submit.prevent="onSubmit">
      <figure class="login_fig" aria-hidden="true">
        <svg width="120" height="72" viewBox="0 0 120 90">
          <rect x="52" y="10" width="34" height="34" rx="10" fill="#1abcfe" opacity="0.85" />
          <circle cx="30" cy="34" r="20" fill="#a259ff" opacity="0.65" />
          <circle cx="88" cy="58" r="24" fill="#ff7262" opacity="0.55" />
          <circle cx="56" cy="68" r="5" fill="#0acf83" />
        </svg>
      </figure>
      <h1>管理员登录</h1>
      <el-form @submit.prevent>
        <el-form-item>
          <el-input
            v-model="password"
            type="password"
            placeholder="密码"
            autocomplete="current-password"
            show-password
            @keyup.enter="onSubmit"
          />
        </el-form-item>
        <el-button class="login_submit" type="primary" native-type="submit" :loading="loading" @click="onSubmit">
          登录
        </el-button>
      </el-form>
      <p v-if="error" class="login_error">{{ error }}</p>
    </form>
  </div>
</template>

<style scoped lang="scss">
.login_page {
  position: fixed;
  inset: 0;
  background: color-mix(in srgb, var(--brand-red) 10%, var(--bg));
  display: flex;
  align-items: center;
  justify-content: center;
}

.login_card {
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  padding: 32px 36px;
  width: min(360px, calc(100vw - 32px));
  display: flex;
  flex-direction: column;
  gap: 10px;
  box-shadow: var(--shadow-card);
}

.login_fig {
  margin: 0;
  text-align: center;
}

h1 {
  margin: 0 0 8px;
  font-size: 32px;
  font-weight: 600;
  letter-spacing: -0.02em;
  text-align: center;
}

.login_submit {
  width: 100%;
}

.login_error {
  color: var(--err);
  margin: 0;
  font-size: 15px;
}
</style>
