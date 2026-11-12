<script setup lang="ts">
import { reactive, ref } from 'vue'
import { changePassword } from '@/api/settings'

/** 控制台密码修改盒：本地校验先行，成功后清空并提示其它会话已退出。 */
const form = reactive({ current: '', next: '', confirm: '' })
const busy = ref(false)
const errText = ref('')
const okText = ref('')

async function submit(): Promise<void> {
  if (busy.value) return
  errText.value = ''
  okText.value = ''
  if (!form.current) return fail('请输入当前密码')
  if (form.next.length < 8) return fail('新密码至少 8 位')
  if (form.next !== form.confirm) return fail('两次输入的新密码不一致')
  busy.value = true
  try {
    await changePassword({ currentPassword: form.current, newPassword: form.next })
    form.current = form.next = form.confirm = ''
    okText.value = '密码已更新，其它会话已退出'
  } catch (err) {
    errText.value = err instanceof Error ? err.message : String(err)
  } finally {
    busy.value = false
  }
}

function fail(msg: string): void {
  errText.value = msg
}

defineOptions({ name: 'PasswordBox' })
</script>

<template>
  <div class="panel_box">
    <h3>控制台密码</h3>
    <div class="form_row">
      <el-input v-model="form.current" type="password" placeholder="当前密码" autocomplete="current-password" show-password class="pw_input" />
      <el-input v-model="form.next" type="password" placeholder="新密码（至少 8 位）" autocomplete="new-password" show-password class="pw_input" />
      <el-input v-model="form.confirm" type="password" placeholder="确认新密码" autocomplete="new-password" show-password class="pw_input" />
      <el-button type="primary" :loading="busy" @click="submit">保存密码</el-button>
    </div>
    <p v-if="errText" class="error">{{ errText }}</p>
    <p v-if="okText" class="state_ok">{{ okText }}</p>
  </div>
</template>

<style scoped lang="scss">
.panel_box {
  background: var(--bg-alt);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  padding: 24px;
  margin: 16px 0;
}

h3 {
  margin: 0 0 12px;
  font-size: 15px;
  font-weight: 600;
  color: var(--text-muted);
}

.form_row {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.pw_input {
  flex: 1 1 200px;
  max-width: 320px;
}

.error {
  color: var(--err);
  margin: 8px 0 0;
}

.state_ok {
  color: var(--ok);
  margin: 8px 0 0;
}
</style>
