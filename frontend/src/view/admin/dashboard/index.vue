<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import type { EChartsCoreOption } from 'echarts/core'
import { fetchModels, fetchOverview, fetchPools, fetchStats } from '@/api/dashboard'
import type { GatewayModel } from '@/types/models'
import EChart from '@/components/common/EChart.vue'
import MetricRow from '@/components/data/MetricRow.vue'
import type { MetricItem } from '@/components/data/MetricRow.vue'
import HandTable from '@/components/data/HandTable.vue'
import type { HandColumn } from '@/components/data/HandTable.vue'

const loading = ref(true)
const errorText = ref('')
const today = ref<MetricItem[]>([])
const degraded = ref(false)
const stats = ref<{ date: string; requests: number; errors: number }[]>([])
const poolRows = ref<{ name: string; count: number; ratio: number | null }[]>([])
const models = ref<GatewayModel[]>([])
const poolFilter = ref('')

function fmtTokens(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`
  return String(n)
}

async function load(): Promise<void> {
  loading.value = true
  errorText.value = ''
  try {
    const [overview, pools, statDays, modelList] = await Promise.all([
      fetchOverview(),
      fetchPools(),
      fetchStats(),
      fetchModels(),
    ])
    degraded.value = overview.usageDegraded === true
    today.value = [
      { k: '请求', v: overview.today.requests },
      { k: '错误', v: overview.today.errors },
      { k: '输入 tokens', v: fmtTokens(overview.today.inputTokens) },
      { k: '输出 tokens', v: fmtTokens(overview.today.outputTokens) },
    ]
    stats.value = statDays
    poolRows.value = pools.map((p) => {
      const ratios = (p.accounts ?? []).map((a) => a.quotaRatio).filter((r): r is number => r != null)
      const avg = ratios.length ? ratios.reduce((a, b) => a + b, 0) / ratios.length : null
      return { name: p.name, count: (p.accounts ?? []).length, ratio: avg }
    })
    models.value = modelList
  } catch (err) {
    errorText.value = err instanceof Error ? err.message : String(err)
  } finally {
    loading.value = false
  }
}

onMounted(load)

const poolOptions = computed(() => [...new Set(models.value.map((m) => m.pool))])
const filteredModels = computed(() =>
  poolFilter.value ? models.value.filter((m) => m.pool === poolFilter.value) : models.value,
)

const modelColumns: HandColumn[] = [
  { key: 'id', label: '调用名' },
  { key: 'display', label: '显示名' },
  { key: 'upstream', label: '上游模型' },
  { key: 'pool', label: '池' },
  { key: 'context', label: '上下文', align: 'right' },
  { key: 'tools', label: 'tools', align: 'right' },
  { key: 'thinking', label: 'thinking', align: 'right' },
  { key: 'available', label: '可用', align: 'right' },
]

interface ModelRow extends Record<string, unknown> {
  id: string
  display: string
  upstream: string
  pool: string
  context: string
  tools: string
  thinking: string
  available: string
  availableOk: boolean
}

const modelRows = computed<ModelRow[]>(() =>
  filteredModels.value.map((m) => ({
    id: m.id,
    display: m.display_name || m.id,
    upstream: m.upstream_model || m.id,
    pool: m.pool,
    context: m.context_window ? `${Math.round(m.context_window / 1000)}k` : '—',
    tools: m.supports_tools ? '✓' : '—',
    thinking: m.supports_thinking ? '✓' : '—',
    available: m.available === false ? '不可用' : '✓',
    availableOk: m.available !== false,
  })),
)

const poolColumns: HandColumn[] = [
  { key: 'name', label: '池' },
  { key: 'count', label: '账号数', align: 'right' },
  { key: 'ratio', label: '平均额度' },
]

const trendOption = computed<EChartsCoreOption>(() => ({
  grid: { left: 56, right: 44, top: 32, bottom: 34 },
  legend: { top: 0, left: 0, itemWidth: 10, itemHeight: 10, textStyle: { color: '#6e6e78', fontSize: 11 } },
  tooltip: { trigger: 'axis' },
  xAxis: {
    type: 'category',
    data: stats.value.map((s) => s.date.slice(5)),
    axisLabel: { color: '#6e6e78', fontSize: 11 },
    axisLine: { lineStyle: { color: '#e5e5ea' } },
  },
  yAxis: [
    {
      type: 'value',
      axisLabel: { color: '#6e6e78', fontSize: 11, formatter: (v: number) => v.toLocaleString('zh-CN') },
      splitLine: { lineStyle: { color: '#e5e5ea' } },
    },
    {
      type: 'value',
      max: 100,
      axisLabel: { color: '#6e6e78', fontSize: 11, formatter: '{value}%' },
      splitLine: { show: false },
    },
  ],
  series: [
    { name: '请求量', type: 'bar', data: stats.value.map((s) => s.requests), itemStyle: { color: '#1abcfe', opacity: 0.9 } },
    {
      name: '错误率',
      type: 'line',
      yAxisIndex: 1,
      data: stats.value.map((s) => (s.requests ? Number(((s.errors / s.requests) * 100).toFixed(2)) : 0)),
      itemStyle: { color: '#ff7262' },
      lineStyle: { color: '#ff7262', width: 2 },
      showSymbol: false,
    },
  ],
}))
</script>

<template>
  <div>
    <div class="page_head">
      <h2>仪表盘</h2>
    </div>
    <div v-if="loading" class="loading_row muted">加载中…</div>
    <p v-else-if="errorText" class="error">{{ errorText }}</p>

    <template v-else>
      <section>
        <h3>今日用量</h3>
        <MetricRow :items="today" />
        <el-alert
          v-if="degraded"
          class="degraded_alert"
          type="warning"
          :closable="false"
          title="用量记录降级"
          description="usage 文件超限，已停写"
          show-icon
        />
      </section>

      <section>
        <h3>14 天趋势</h3>
        <EChart v-if="stats.length" :option="trendOption" :height="300" />
        <el-empty v-else description="暂无数据" :image-size="72" />
      </section>

      <section>
        <h3>各池额度</h3>
        <HandTable :columns="poolColumns" :rows="poolRows" empty-text="无池数据">
          <template #cell_ratio="{ row }">
            <el-progress
              v-if="row.ratio != null"
              :percentage="Math.round(row.ratio * 100)"
              :color="row.ratio <= 0.2 ? 'var(--brand-red)' : row.ratio <= 0.5 ? 'var(--brand-orange)' : 'var(--brand-blue)'"
              :stroke-width="8"
              class="quota_bar"
            />
            <span v-else class="muted">无数据</span>
          </template>
        </HandTable>
      </section>

      <section>
        <div class="models_head">
          <h3>模型列表</h3>
          <el-select v-model="poolFilter" placeholder="全部池" clearable class="pool_select">
            <el-option v-for="p in poolOptions" :key="p" :label="p" :value="p" />
          </el-select>
        </div>
        <p class="muted models_hint">调用时 model 填完整调用名（<code>池名/模型ID</code>），网关自动映射到上游模型。</p>
        <HandTable :columns="modelColumns" :rows="modelRows" empty-text="该池暂无模型">
          <template #cell_id="{ row }">
            <span class="mono">{{ row.id }}</span>
          </template>
          <template #cell_upstream="{ row }">
            <span class="mono">{{ row.upstream }}</span>
          </template>
          <template #cell_available="{ row }">
            <span :class="row.availableOk ? '' : 'unavailable'">{{ row.available }}</span>
          </template>
        </HandTable>
      </section>
    </template>
  </div>
</template>

<style scoped lang="scss">
.page_head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 16px;
}

.loading_row {
  padding: 48px 0;
}

h2 {
  margin: 0;
  font-size: 24px;
  font-weight: 600;
  letter-spacing: -0.02em;
}

h3 {
  margin: 0 0 8px;
  font-size: 15px;
  font-weight: 600;
  color: var(--text-muted);
}

section {
  margin-bottom: 24px;
}

.error {
  color: var(--err);
}

.degraded_alert {
  margin-top: 16px;
}

.quota_bar {
  width: 120px;
}

.models_head {
  display: flex;
  align-items: center;
  gap: 12px;

  h3 {
    margin: 0;
  }
}

.pool_select {
  width: 160px;
}

.models_hint {
  margin: 4px 0 8px;
  font-size: 13px;
}

.unavailable {
  color: var(--err);
}
</style>
