<script setup lang="ts">
import { onBeforeUnmount, ref } from 'vue'
import { registerToast, type ToastType } from '@/composables/useToast'

/**
 * AppToast 宿主：全站轻提示（ElMessage 的 CSP 替代）。
 * 挂在 App.vue 根部一次；消息栈固定顶部居中，纯 class 定位，零内联 style。
 */
interface ToastItem {
  id: number
  message: string
  type: ToastType
}

const items = ref<ToastItem[]>([])
let seq = 0
const timers = new Map<number, ReturnType<typeof setTimeout>>()

function push(message: string, type: ToastType = 'info'): void {
  const id = ++seq
  items.value.push({ id, message, type })
  timers.set(
    id,
    setTimeout(() => dismiss(id), 2400),
  )
}

function dismiss(id: number): void {
  const t = timers.get(id)
  if (t) clearTimeout(t)
  timers.delete(id)
  items.value = items.value.filter((i) => i.id !== id)
}

registerToast(push)

onBeforeUnmount(() => timers.forEach((t) => clearTimeout(t)))

defineOptions({ name: 'AppToast' })
</script>

<template>
  <teleport to="body">
    <div class="toast_stack" role="status" aria-live="polite">
      <div v-for="item in items" :key="item.id" class="toast_item" :class="`toast_${item.type}`" @click="dismiss(item.id)">
        {{ item.message }}
      </div>
    </div>
  </teleport>
</template>

<style lang="scss">
.toast_stack {
  position: fixed;
  top: 16px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 3000;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  pointer-events: none;
}

.toast_item {
  pointer-events: auto;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 9px 16px;
  font-size: 14px;
  box-shadow: var(--shadow-card);
  cursor: pointer;

  &.toast_success {
    border-color: var(--ok);
    color: var(--ok);
  }

  &.toast_error {
    border-color: var(--err);
    color: var(--err);
  }
}

@media (prefers-reduced-motion: reduce) {
  .toast_item {
    transition: none;
  }
}
</style>
