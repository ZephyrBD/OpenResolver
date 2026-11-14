<script setup lang="ts">
export interface MetricItem {
  k: string
  v: string | number
  unit?: string
  sub?: string
}

withDefaults(
  defineProps<{
    items: MetricItem[]
    /** 五色轮换（内容层，不跟端主色，docs/frontend/09 MetricRow） */
    accents?: string[]
  }>(),
  { accents: () => ['var(--brand-green)', 'var(--brand-blue)', 'var(--brand-purple)', 'var(--brand-orange)', 'var(--brand-red)'] },
)

defineOptions({ name: 'MetricRow' })
</script>

<template>
  <div class="metric_row">
    <div
      v-for="(item, i) in items"
      :key="item.k"
      class="metric_card"
      :class="`accent_${i % accents.length}`"
    >
      <div class="label">{{ item.k }}</div>
      <div class="value">{{ item.v }}<span v-if="item.unit" class="unit">{{ item.unit }}</span></div>
      <div v-if="item.sub" class="sub">{{ item.sub }}</div>
    </div>
  </div>
</template>

<style scoped lang="scss">
.metric_row {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 16px;
}

.metric_card {
  background: color-mix(in srgb, var(--metric-accent) 8%, var(--bg));
  border: 1px solid var(--border);
  border-top: 3px solid var(--metric-accent);
  border-radius: var(--radius-md);
  padding: 24px;
  min-width: 0;
  overflow-wrap: anywhere;
  transition: box-shadow 150ms ease;

  &:hover {
    box-shadow: var(--shadow-card);
  }
}

// 五色轮换走 class（CSP 全维度零内联：禁止 style 属性）
.accent_0 { --metric-accent: var(--brand-green); }
.accent_1 { --metric-accent: var(--brand-blue); }
.accent_2 { --metric-accent: var(--brand-purple); }
.accent_3 { --metric-accent: var(--brand-orange); }
.accent_4 { --metric-accent: var(--brand-red); }

.label {
  color: var(--text-muted);
  font-size: 13px;
  font-weight: 500;
}

.value {
  font-size: 24px;
  font-weight: 600;
  letter-spacing: -0.02em;
  margin-top: 4px;
  font-variant-numeric: tabular-nums;
}

.unit {
  font-size: 15px;
  margin-left: 4px;
  color: var(--text-muted);
}

.sub {
  color: var(--text-muted);
  font-size: 13px;
  margin-top: 4px;
}

@media (max-width: 1080px) {
  .metric_row {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@media (max-width: 768px) {
  .metric_row {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
