<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { fetchQuota, type PoolName, type QuotaEntry } from '@/api/accounts'
import { fmtTime, fmtTokens } from '@/utils/fmt'
import HandProgress from '@/components/data/HandProgress.vue'

/** 额度明细（现场回源，挂载即查一次；claim 成功后父组件可调 refresh()）。 */
const props = defineProps<{ pool: PoolName | string; autoRefresh?: boolean }>()

const loading = ref(false)
const errText = ref('')
const entries = ref<QuotaEntry[]>([])

async function refresh(): Promise<void> {
  loading.value = true
  errText.value = ''
  try {
    entries.value = await fetchQuota(props.pool)
  } catch (err) {
    errText.value = err instanceof Error ? err.message : String(err)
  } finally {
    loading.value = false
  }
}

const rows = computed(() =>
  entries.value.map((q) => ({
    q,
    name: q.label || q.account,
    detailLines: (q.details ?? []).map((d) => {
      const pct = d.percent != null ? `（${Math.round(d.percent * 100)}%）` : ''
      const fmt = /token/i.test(String(d.unit)) ? fmtTokens : String
      const amount =
        d.total != null
          ? `${fmt(d.remaining ?? 0)} / ${fmt(d.total)} ${d.unit ?? ''}${pct}`
          : d.kind === 'unlimited'
            ? '不限量'
            : `— ${d.unit ?? ''}`
      return `${d.name}：${amount}`
    }),
    detailReason:
      q.supported === false
        ? q.source === 'stale' && q.error
          ? `查询失败：${q.error}`
          : (q.reason || (q.error ? `查询失败：${q.error}` : '上游未返回可用的额度信息'))
        : q.error
          ? `查询失败：${q.error}`
          : '无数据',
    period: q.periodEnd ? (q.plan ? `${fmtTime(q.periodEnd)} · ${q.plan}` : fmtTime(q.periodEnd)) : (q.plan || '—'),
    checkin: q.checkin ? (q.checkin.checkedIn ? `已签（${q.checkin.credits ?? 0}）` : (q.checkin.message || '未签')) : '—',
  })),
)

onMounted(() => {
  if (props.autoRefresh) void refresh()
})

defineExpose({ refresh })
defineOptions({ name: 'QuotaDetails' })
</script>

<template>
  <div class="panel_box">
    <div class="head_row">
      <h3>额度明细</h3>
      <el-button :loading="loading" @click="refresh">刷新额度明细</el-button>
    </div>
    <p v-if="errText" class="error">{{ errText }}</p>
    <table v-else-if="rows.length" class="hand_table">
      <thead>
        <tr>
          <th>账号</th>
          <th width="130">额度</th>
          <th>明细</th>
          <th>周期/套餐</th>
          <th>签到</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="row.q.account">
          <td>
            <div>{{ row.name }}</div>
            <div v-if="row.name !== row.q.account" class="muted mono">{{ row.q.account }}</div>
          </td>
          <td>
            <HandProgress
              v-if="row.q.ratio != null"
              :percentage="Math.round(row.q.ratio * 100)"
              :color="row.q.ratio <= 0.2 ? 'var(--brand-red)' : row.q.ratio <= 0.5 ? 'var(--brand-orange)' : 'var(--brand-blue)'"
              :width="110"
            />
            <span v-else class="muted">无数据</span>
          </td>
          <td>
            <div v-for="line in row.detailLines" :key="line">
              <span class="mono">{{ line }}</span>
            </div>
            <span v-if="!row.detailLines.length" class="muted">{{ row.detailReason }}</span>
          </td>
          <td class="mono">{{ row.period }}</td>
          <td>{{ row.checkin }}</td>
        </tr>
      </tbody>
    </table>
    <el-empty v-else-if="!loading" description="无额度数据" :image-size="64" />
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

.head_row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 12px;

  h3 {
    margin: 0;
    font-size: 15px;
    font-weight: 600;
    color: var(--text-muted);
  }
}

.error {
  color: var(--err);
  margin: 0;
}
</style>
