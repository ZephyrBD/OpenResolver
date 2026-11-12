<script setup lang="ts">
import { computed } from 'vue'

/**
 * AppSelect：el-select 的 CSP 替代（弹层定位依赖 popper 内联 style）。
 * 原生 select + 自绘箭头，视觉对齐 el-input（登记组件清单）。
 */
const props = withDefaults(
  defineProps<{
    modelValue: string
    options: Array<{ label: string; value: string }>
    placeholder?: string
    /** 允许清空：渲染一个空值选项 */
    clearable?: boolean
  }>(),
  { placeholder: '', clearable: false },
)

const emit = defineEmits<{ 'update:modelValue': [value: string] }>()

const isEmpty = computed(() => props.modelValue === '')

defineOptions({ name: 'AppSelect', inheritAttrs: false })
</script>

<template>
  <span class="app_select" v-bind="$attrs">
    <select :value="modelValue" @change="emit('update:modelValue', ($event.target as HTMLSelectElement).value)">
      <option v-if="clearable || isEmpty && !options.some((o) => o.value === '')" value="">
        {{ placeholder || '全部' }}
      </option>
      <option v-for="o in options" :key="o.value" :value="o.value">{{ o.label }}</option>
    </select>
    <svg class="arrow" width="10" height="6" viewBox="0 0 10 6" aria-hidden="true">
      <path d="M1 1l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
    </svg>
  </span>
</template>

<style scoped lang="scss">
.app_select {
  position: relative;
  display: inline-flex;
  align-items: center;

  select {
    appearance: none;
    background: var(--bg);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 6px 26px 6px 11px;
    font: inherit;
    font-size: 14px;
    cursor: pointer;
    transition: border-color 120ms ease, box-shadow 120ms ease;

    &:focus-visible {
      border-color: var(--accent);
      outline: none;
      box-shadow: 0 0 0 2px var(--accent-10);
    }
  }

  .arrow {
    position: absolute;
    right: 9px;
    pointer-events: none;
    color: var(--text-muted);
  }
}
</style>
