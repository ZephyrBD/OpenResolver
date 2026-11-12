<script setup lang="ts">
import { ref } from 'vue'
import AppDialog from '@/components/common/AppDialog.vue'

/**
 * ConfirmHost：全站二次确认宿主（ElMessageBox 的 CSP 替代，配 useConfirm 使用）。
 * 挂在 App.vue 根部一次即可。
 */
interface PendingConfirm {
  message: string
  danger: boolean
  resolve: (ok: boolean) => void
}

const pending = ref<PendingConfirm | null>(null)
const dlg = ref<InstanceType<typeof AppDialog> | null>(null)

function confirm(message: string, { danger = false } = {}): Promise<boolean> {
  return new Promise((resolve) => {
    pending.value = { message, danger, resolve }
    requestAnimationFrame(() => dlg.value?.open())
  })
}

function settle(ok: boolean): void {
  dlg.value?.close()
  pending.value?.resolve(ok)
  pending.value = null
}

defineExpose({ confirm })
defineOptions({ name: 'ConfirmHost' })
</script>

<template>
  <AppDialog ref="dlg" :title="pending?.message || ''" locked>
    <div class="confirm_actions">
      <el-button :type="pending?.danger ? 'danger' : 'primary'" @click="settle(true)">确认</el-button>
      <el-button @click="settle(false)">取消</el-button>
    </div>
  </AppDialog>
</template>

<style scoped lang="scss">
.confirm_actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  margin-top: 8px;
}
</style>
