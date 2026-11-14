<script setup lang="ts">
import { computed } from 'vue'

/** HandProgress：el-progress 的 CSP 替代（el-progress 条宽用内联 style）。SVG width 属性实现，登记组件清单。 */
const props = withDefaults(
  defineProps<{
    percentage: number
    /** 颜色：直接给色值（分档色由调用方算好传入） */
    color?: string
    strokeWidth?: number
    width?: number
  }>(),
  { color: 'var(--brand-blue)', strokeWidth: 8, width: 120 },
)

const w = computed(() => Math.max(0, Math.min(100, props.percentage)))

defineOptions({ name: 'HandProgress', inheritAttrs: false })
</script>

<template>
  <span class="hand_progress" v-bind="$attrs">
    <svg
      :width="width"
      :height="strokeWidth"
      :viewBox="`0 0 ${width} ${strokeWidth}`"
      role="progressbar"
      :aria-valuenow="w"
      aria-valuemin="0"
      aria-valuemax="100"
    >
      <rect x="0" y="0" :width="width" :height="strokeWidth" rx="4" fill="var(--border)" />
      <rect x="0" y="0" :width="Math.round((width * w) / 100)" :height="strokeWidth" rx="4" :fill="color" />
    </svg>
    <span class="pct muted">{{ w }}%</span>
  </span>
</template>

<style scoped lang="scss">
.hand_progress {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.pct {
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}

svg {
  display: block;
}
</style>
