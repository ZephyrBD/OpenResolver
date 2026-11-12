<script setup lang="ts">
import { onBeforeUnmount, ref } from 'vue'

/**
 * AppDialog：原生 <dialog> 弹层（ElDialog/ElMessageBox 依赖 popper 内联 style，
 * 触「CSP 优先」裁定，故自研并登记组件清单）。视觉复刻 ElDialog 规格（Design-md §6）。
 * 用法：ref.open() 打开；Esc/遮罩点击关闭（locked 时只认 close()），关闭即 emit('close')。
 */
const props = defineProps<{ title: string; locked?: boolean }>()
const emit = defineEmits<{ close: [] }>()

const dlg = ref<HTMLDialogElement | null>(null)

function onBackdrop(ev: MouseEvent): void {
  if (ev.target === dlg.value && !props.locked) close()
}

function onCancel(ev: Event): void {
  ev.preventDefault() // 统一走 close() 的 remove 路径；locked 时即拦截 Esc
  if (!props.locked) close()
}

function close(): void {
  dlg.value?.close()
  emit('close')
}

function open(): void {
  dlg.value?.showModal()
}

defineExpose({ open, close })
defineOptions({ name: 'AppDialog' })

onBeforeUnmount(() => dlg.value?.open && dlg.value.close())
</script>

<template>
  <dialog ref="dlg" class="app_dlg" @cancel="onCancel" @click="onBackdrop">
    <h3 class="app_dlg_title">{{ title }}</h3>
    <div class="app_dlg_body">
      <slot />
    </div>
  </dialog>
</template>

<style scoped lang="scss">
.app_dlg {
  border: none;
  border-radius: var(--radius-lg);
  max-width: min(720px, calc(100vw - 32px));
  max-height: calc(100vh - 48px);
  overflow-y: auto;
  padding: 24px 28px;
  box-shadow: var(--shadow-card);
  background: var(--bg);
  color: var(--text);
}

.app_dlg::backdrop {
  background: rgba(15, 15, 20, 0.35);
}

.app_dlg[open] {
  animation: dlg_in 150ms ease-out;
}

@keyframes dlg_in {
  from {
    opacity: 0;
    transform: scale(0.92);
  }
  to {
    opacity: 1;
    transform: scale(1);
  }
}

.app_dlg_title {
  margin: 0 0 16px;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--border);
  color: var(--text);
  font-size: 17px;
  letter-spacing: -0.01em;
}

.app_dlg_body {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

@media (max-width: 768px) {
  .app_dlg {
    width: 92vw;
    max-width: none;
    margin: auto;
    padding: 20px 18px;
  }
}

@media (prefers-reduced-motion: reduce) {
  .app_dlg[open] {
    animation: none;
  }
}
</style>
