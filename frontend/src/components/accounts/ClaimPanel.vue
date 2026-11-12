<script setup lang="ts">
import { ref } from 'vue'
import { claimPool, type ClaimResult, type PoolName } from '@/api/accounts'
import { accountName } from '@/utils/fmt'

/**
 * 整池领取（弹层内容）：打开即执行；执行中变灰防双击；
 * 混有失败时保持弹层开放展示明细、按钮恢复可重试；全部成功关弹层。
 */
const props = defineProps<{ pool: PoolName | string; onSuccess: () => void; onClose: () => void }>()

const busy = ref(true)
const errText = ref('')
const results = ref<ClaimResult[] | null>(null)

async function run(): Promise<void> {
  busy.value = true
  errText.value = ''
  try {
    const out = await claimPool(props.pool)
    if (!out.length) {
      props.onSuccess()
      props.onClose()
      return
    }
    results.value = out
    props.onSuccess()
    if (!out.some((r) => r.status === 'failed')) {
      props.onClose()
      return
    }
    busy.value = false // 混有失败：保持弹层开放，按钮恢复可重试
  } catch (err) {
    results.value = null
    errText.value = err instanceof Error ? err.message : String(err)
    busy.value = false
  }
}

run()

defineOptions({ name: 'ClaimPanel' })
</script>

<template>
  <div>
    <p v-if="busy" class="muted">领取中…</p>
    <div v-else class="form_row">
      <el-button type="primary" @click="run">重试（整池）</el-button>
    </div>
    <p v-if="errText" class="error">{{ errText }}</p>
    <table v-if="results" class="hand_table">
      <thead>
        <tr>
          <th>账号</th>
          <th>结果</th>
          <th>积分</th>
          <th>说明</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="r in results" :key="r.account">
          <td>
            <div>{{ r.label || r.account }}</div>
            <div v-if="accountName({ label: r.label, id: r.account }) !== (r.label || '')" class="muted mono">{{ r.account }}</div>
          </td>
          <td>
            <span :class="r.status === 'claimed' ? 'state_ok' : r.status === 'failed' ? 'error' : 'muted'">{{ r.status }}</span>
          </td>
          <td class="mono">{{ r.credits ?? 0 }}</td>
          <td>
            <div v-if="r.claimed?.length">{{ r.claimed.join(', ') }}{{ r.message ? `；${r.message}` : '' }}</div>
            <div v-else-if="r.message">{{ r.message }}</div>
            <div v-if="r.detail?.tried?.length" class="muted mono">
              {{ r.detail.tried.map((t) => `${t.planId ?? '?'}:${t.code ?? ''} ${t.msg ?? ''}`).join('；') }}
            </div>
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

<style scoped lang="scss">
.form_row {
  display: flex;
  align-items: center;
  gap: 10px;
}

.error {
  color: var(--err);
  margin: 0;
}

.state_ok {
  color: var(--ok);
}
</style>
