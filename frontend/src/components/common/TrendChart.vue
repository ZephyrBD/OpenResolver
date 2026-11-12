<script setup lang="ts">
import { computed } from 'vue'

/**
 * TrendChart：纯 SVG 请求量柱状（左轴）+ 错误率折线（右轴），14 天。
 * el-select/ECharts 均触「CSP 全维度零内联」裁定：ECharts 会向容器写内联 style，
 * 故按旧面板 trendChart 平移为属性绑定的纯 SVG（登记组件清单；echarts 依赖随之移除）。
 */
const props = defineProps<{ stats: Array<{ date: string; requests: number; errors: number }> }>()

const W = 960
const H = 300
const PAD_L = 56
const PAD_R = 44
const PAD_T = 16
const PAD_B = 34

const plotH = H - PAD_T - PAD_B
const bottom = PAD_T + plotH

const maxReq = computed(() => Math.max(1, ...props.stats.map((s) => s.requests)))

const fmtTick = (n: number): string => new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 0 }).format(n)

const ticks = computed(() => [
  { y: bottom, req: 0, pct: '0%' },
  { y: bottom - plotH / 2, req: maxReq.value / 2, pct: '50%' },
  { y: PAD_T, req: maxReq.value, pct: '100%' },
])

const bars = computed(() => {
  const barW = (W - PAD_L - PAD_R) / props.stats.length
  return props.stats.map((s, i) => {
    const x = PAD_L + barW * i
    const h = (s.requests / maxReq.value) * plotH
    return {
      x: x + barW * 0.2,
      y: bottom - h,
      w: barW * 0.6,
      h: Math.max(h, s.requests ? 1 : 0),
      label: s.date.slice(5),
      showLabel: i === 0 || i === props.stats.length - 1 || i % 2 === 0,
    }
  })
})

const linePoints = computed(() => {
  const barW = (W - PAD_L - PAD_R) / props.stats.length
  return props.stats
    .map((s, i) => {
      const x = PAD_L + barW * i + barW / 2
      const rate = s.requests ? (s.errors / s.requests) * 100 : 0
      return `${x},${bottom - plotH * (rate / 100)}`
    })
    .join(' ')
})

defineOptions({ name: 'TrendChart', inheritAttrs: false })
</script>

<template>
  <svg
    class="trend_chart"
    :viewBox="`0 0 ${W} ${H}`"
    role="img"
    aria-label="近 14 天请求量与错误率趋势"
    v-bind="$attrs"
  >
    <template v-if="!stats.length">
      <text :x="W / 2" :y="H / 2" fill="var(--text-muted)" font-size="14" text-anchor="middle">暂无数据</text>
    </template>
    <template v-else>
      <g v-for="(tick, i) in ticks" :key="`tick_${i}`">
        <line :x1="PAD_L" :y1="tick.y" :x2="W - PAD_R" :y2="tick.y" stroke="var(--border)" stroke-width="1" />
        <text :x="PAD_L - 8" :y="tick.y + 4" fill="var(--text-muted)" font-size="11" text-anchor="end">
          {{ fmtTick(tick.req) }}
        </text>
        <text :x="W - 8" :y="tick.y + 4" fill="var(--text-muted)" font-size="11" text-anchor="end">{{ tick.pct }}</text>
      </g>
      <rect
        v-for="(bar, i) in bars"
        :key="`bar_${i}`"
        :x="bar.x"
        :y="bar.y"
        :width="bar.w"
        :height="bar.h"
        fill="var(--brand-blue)"
        opacity="0.9"
      />
      <polyline :points="linePoints" fill="none" stroke="var(--brand-red)" stroke-width="2" />
      <text
        v-for="(bar, i) in bars.filter((b) => b.showLabel)"
        :key="`label_${i}`"
        :x="bar.x + bar.w / 2"
        :y="H - 12"
        fill="var(--text-muted)"
        font-size="11"
        text-anchor="middle"
      >
        {{ bar.label }}
      </text>
      <g>
        <rect :x="PAD_L" y="4" width="10" height="10" rx="2" fill="var(--brand-blue)" />
        <text :x="PAD_L + 16" y="13" fill="var(--text-muted)" font-size="11">请求量</text>
        <line :x1="PAD_L + 74" y1="9" :x2="PAD_L + 90" y2="9" stroke="var(--brand-red)" stroke-width="2" />
        <text :x="PAD_L + 96" y="13" fill="var(--text-muted)" font-size="11">错误率</text>
      </g>
    </template>
  </svg>
</template>

<style scoped lang="scss">
.trend_chart {
  width: 100%;
  height: auto;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
}
</style>
