<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import {
  POOL_NAMES,
  deleteAccount,
  fetchAccounts,
  patchAccount,
  resetAccount,
  type OnboardAccount,
  type PoolAccount,
  type PoolName,
} from '@/api/accounts'
import { accountName, displayWithId } from '@/utils/fmt'
import { confirm } from '@/composables/useConfirm'
import AppDialog from '@/components/common/AppDialog.vue'
import AppSelect from '@/components/common/AppSelect.vue'
import QuotaDetails from '@/components/accounts/QuotaDetails.vue'
import ClaimPanel from '@/components/accounts/ClaimPanel.vue'
import ManualImportPanel from '@/components/accounts/ManualImportPanel.vue'
import OnboardZcode from '@/components/accounts/OnboardZcode.vue'
import OnboardQoder from '@/components/accounts/OnboardQoder.vue'
import OnboardTrae from '@/components/accounts/OnboardTrae.vue'
import OnboardWorkbuddy from '@/components/accounts/OnboardWorkbuddy.vue'
import OnboardCodearts from '@/components/accounts/OnboardCodearts.vue'

// 池选择仅内存（docs/frontend/08 §3：运行态不落 localStorage/sessionStorage）
const pool = ref<PoolName>('zcode')
const accounts = ref<PoolAccount[]>([])
const loading = ref(true)
const errText = ref('')

const quotaRef = ref<InstanceType<typeof QuotaDetails> | null>(null)
const onboardDlg = ref<InstanceType<typeof AppDialog> | null>(null)
const manualDlg = ref<InstanceType<typeof AppDialog> | null>(null)
const claimDlg = ref<InstanceType<typeof AppDialog> | null>(null)

async function reload(): Promise<void> {
  loading.value = true
  errText.value = ''
  try {
    accounts.value = await fetchAccounts(pool.value)
  } catch (err) {
    errText.value = err instanceof Error ? err.message : String(err)
  } finally {
    loading.value = false
  }
}

watch(pool, reload, { immediate: true })

function onOnboardDone(_account: OnboardAccount): void {
  void reload()
  quotaRef.value?.refresh()
}

// 冷却倒计时：客户端 1s tick 只做展示（docs/backend/06 §3：状态由调度器派生）
const now = ref(Date.now())
const ticker = setInterval(() => (now.value = Date.now()), 1000)
onBeforeUnmount(() => clearInterval(ticker))

function cooldownText(acc: PoolAccount): string {
  const remain = Math.max(0, (acc.cooldownUntil || 0) - now.value)
  if (remain <= 0) return acc.cooldownKind ? '已到期' : '—'
  const min = Math.floor(remain / 60_000)
  const sec = Math.floor((remain % 60_000) / 1000)
  return `${min}:${String(sec).padStart(2, '0')}${acc.cooldownKind ? ` (${acc.cooldownKind})` : ''}`
}

function cooldownClass(acc: PoolAccount): string {
  const remain = Math.max(0, (acc.cooldownUntil || 0) - now.value)
  return remain <= 0 ? 'muted' : 'cooling'
}

interface RowDraft {
  enabled: boolean
  weight: number
}

const drafts = ref<Record<string, RowDraft>>({})

watch(
  accounts,
  (list) => {
    const next: Record<string, RowDraft> = {}
    for (const acc of list) {
      next[acc.id] = { enabled: acc.enabled, weight: acc.manualWeight ?? 10 }
    }
    drafts.value = next
  },
  { deep: true },
)

async function saveAccount(acc: PoolAccount): Promise<void> {
  errText.value = ''
  const draft = drafts.value[acc.id]
  if (!draft) return
  if (!Number.isInteger(draft.weight) || draft.weight < 0 || draft.weight > 20) {
    errText.value = `账号 ${displayWithId(accountName(acc), acc.id)}：权重须为 0-20 的整数`
    return
  }
  try {
    await patchAccount(pool.value, acc.id, { label: acc.label, enabled: draft.enabled, manualWeight: draft.weight })
    await reload()
  } catch (err) {
    errText.value = err instanceof Error ? err.message : String(err)
  }
}

async function clearCooldown(acc: PoolAccount): Promise<void> {
  errText.value = ''
  try {
    await resetAccount(pool.value, acc.id)
    await reload()
  } catch (err) {
    errText.value = err instanceof Error ? err.message : String(err)
  }
}

async function removeAccount(acc: PoolAccount): Promise<void> {
  const ok = await confirm(`确定删除账号 ${displayWithId(accountName(acc), acc.id)}？此操作不可恢复。`, { danger: true })
  if (!ok) return
  errText.value = ''
  try {
    await deleteAccount(pool.value, acc.id)
    await reload()
  } catch (err) {
    errText.value = err instanceof Error ? err.message : String(err)
  }
}

const nameOf = (acc: PoolAccount): string => acc.label || acc.nickname || acc.email || acc.id
const stateOf = (acc: PoolAccount): string => (acc.enabled ? acc.state : 'disabled')
const showOnboard = computed(() => (POOL_NAMES as readonly string[]).includes(pool.value))
const showManualImport = computed(() => pool.value === 'zcode')
</script>

<template>
  <div>
    <div class="page_head">
      <h2>账号</h2>
      <AppSelect
        v-model="pool"
        :options="POOL_NAMES.map((name) => ({ label: name, value: name }))"
        class="pool_select"
      />    </div>

    <div class="action_row">
      <el-button v-if="showOnboard" type="primary" @click="onboardDlg?.open()">登录接入</el-button>
      <el-button v-if="showManualImport" @click="manualDlg?.open()">手动导入</el-button>
      <el-button @click="claimDlg?.open()">领取 / 签到</el-button>
    </div>

    <p v-if="errText" class="error">{{ errText }}</p>
    <p v-if="loading" class="muted loading_row">加载中…</p>

    <table v-else class="hand_table">
      <thead>
        <tr>
          <th>名称 / ID</th>
          <th>状态</th>
          <th width="72">启用</th>
          <th width="96">权重</th>
          <th width="120">冷却</th>
          <th class="actions_col">操作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="acc in accounts" :key="acc.id">
          <td>
            <div>{{ nameOf(acc) }}</div>
            <div v-if="acc.id !== nameOf(acc)" class="muted mono">{{ acc.id }}</div>
            <div v-if="acc.email && acc.email !== nameOf(acc)" class="muted">{{ acc.email }}</div>
          </td>
          <td>
            <span :class="acc.enabled ? (acc.state === 'ok' ? 'state_ok' : 'error') : 'muted'">{{ stateOf(acc) }}</span>
            <div v-if="acc.consecutiveFails" class="muted">连败 {{ acc.consecutiveFails }}</div>
          </td>
          <td>
            <el-switch v-if="drafts[acc.id]" v-model="drafts[acc.id].enabled" />
          </td>
          <td>
            <el-input-number
              v-if="drafts[acc.id]"
              v-model="drafts[acc.id].weight"
              :min="0"
              :max="20"
              :step="1"
              step-strictly
              controls-position="right"
              class="weight_input"
            />
          </td>
          <td>
            <span :class="cooldownClass(acc)" class="mono">{{ cooldownText(acc) }}</span>
          </td>
          <td class="actions_col">
            <el-button size="small" @click="saveAccount(acc)">保存</el-button>
            <el-button size="small" @click="clearCooldown(acc)">清冷却</el-button>
            <el-button size="small" type="danger" plain @click="removeAccount(acc)">删除</el-button>
          </td>
        </tr>
        <tr v-if="!accounts.length">
          <td colspan="6">
            <el-empty description="暂无账号——用「登录接入」接入一个" :image-size="72" />
          </td>
        </tr>
      </tbody>
    </table>

    <QuotaDetails
      v-if="accounts.length"
      ref="quotaRef"
      :pool="pool"
      auto-refresh
    />

    <AppDialog ref="onboardDlg" :title="`登录接入 ${pool}`">
      <component
        :is="pool === 'zcode' ? OnboardZcode : pool.startsWith('qoder') ? OnboardQoder : pool === 'trae' ? OnboardTrae : pool.startsWith('workbuddy') ? OnboardWorkbuddy : OnboardCodearts"
        @done="onOnboardDone"
      />
    </AppDialog>

    <AppDialog ref="manualDlg" title="手动导入 zcode" @close="">
      <ManualImportPanel :pool="pool" :on-done="onOnboardDone" @close="manualDlg?.close()" />
    </AppDialog>

    <AppDialog ref="claimDlg" :title="`领取 ${pool}`">
      <ClaimPanel :pool="pool" :on-success="() => quotaRef?.refresh()" :on-close="() => claimDlg?.close()" />
    </AppDialog>
  </div>
</template>

<style scoped lang="scss">
.page_head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 16px;

  h2 {
    margin: 0;
    font-size: 24px;
    font-weight: 600;
    letter-spacing: -0.02em;
  }
}

.pool_select {
  width: 180px;
}

.action_row {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
  margin-bottom: 16px;
}

.loading_row {
  padding: 24px 0;
}

.error {
  color: var(--err);
  margin: 0 0 12px;
  white-space: pre-wrap;
}

.state_ok {
  color: var(--ok);
}

.cooling {
  color: var(--warn);
}

.actions_col {
  white-space: nowrap;
}

.weight_input {
  width: 96px;
}
</style>
