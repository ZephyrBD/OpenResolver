<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue'
import { fetchSettings, patchSettings, type PoolSettings } from '@/api/settings'
import PasswordBox from '@/components/settings/PasswordBox.vue'

/**
 * 设置页：全局一份，应用到所有池。
 * 展示换算（旧面板约定平移）：毫秒字段 ÷ factor 显示为分钟/秒/小时；布尔 0/1；汇率浮点原样。
 * 保存反向换算：浮点原样、factor>0 取整回毫秒、布尔钳 0/1、其余整数。
 */
interface FieldSpec {
  key: keyof PoolSettings
  label: string
  unit: string
  /** 展示换算因子（>0 时输入值 × factor = 存储值） */
  factor: number
  isFloat?: boolean
}

const GROUPS: Array<{ title: string; fields: FieldSpec[] }> = [
  {
    title: '调度',
    fields: [
      { key: 'maxInFlight', label: '单账号最大并发', unit: '个', factor: 0 },
      { key: 'topN', label: '候选 Top-N', unit: '个', factor: 0 },
      { key: 'maxAttempts', label: '单请求最大尝试账号数', unit: '个', factor: 0 },
      { key: 'stickyTtlMs', label: '粘性会话有效期', unit: '分钟', factor: 60_000 },
    ],
  },
  {
    title: '冷却',
    fields: [
      { key: 'busyCooldownMs', label: '限流首犯冷却', unit: '分钟', factor: 60_000 },
      { key: 'quotaCooldownMs', label: '限流连犯冷却', unit: '分钟', factor: 60_000 },
      { key: 'blockedCooldownMs', label: '风控/3012 冷却', unit: '分钟', factor: 60_000 },
      { key: 'serverCooldownMs', label: '上游 5xx/网络冷却', unit: '秒', factor: 1000 },
      { key: 'quotaExhaustedCooldownMs', label: '额度耗尽冷却', unit: '小时', factor: 3_600_000 },
      { key: 'breakerThreshold', label: '熔断阈值', unit: '次', factor: 0 },
      { key: 'breakerCooldownMs', label: '熔断基数', unit: '分钟', factor: 60_000 },
      { key: 'breakerCapMs', label: '熔断封顶', unit: '小时', factor: 3_600_000 },
    ],
  },
  {
    title: '自动领取',
    fields: [
      { key: 'autoClaimEnabled', label: '每日自动领取', unit: '', factor: 0 },
      { key: 'autoClaimHour', label: '每日补领时点', unit: '点', factor: 0 },
      { key: 'weekendGrabEnabled', label: 'ZCode 周末活动包抢领', unit: '', factor: 0 },
    ],
  },
  {
    title: '余额折算（credits → token）',
    fields: [
      { key: 'wbCreditTokensRate', label: 'WorkBuddy 积分 → token', unit: '×', factor: 0, isFloat: true },
      { key: 'qoderCreditTokensRate', label: 'Qoder 积分 → token', unit: '×', factor: 0, isFloat: true },
      { key: 'codeartsCreditTokensRate', label: 'CodeArts 积分 → token', unit: '×', factor: 0, isFloat: true },
    ],
  },
]

const BOOLEAN_KEYS = new Set(['autoClaimEnabled', 'weekendGrabEnabled'])

const loading = ref(true)
const errText = ref('')
const groups = ref<typeof GROUPS>([])
const draft = reactive<Record<string, string>>({})

async function load(): Promise<void> {
  loading.value = true
  errText.value = ''
  try {
    const settings = await fetchSettings()
    for (const g of GROUPS) {
      for (const f of g.fields) {
        draft[f.key] = f.isFloat
          ? String(settings[f.key])
          : f.factor > 0
            ? String(settings[f.key] / f.factor)
            : String(settings[f.key] ? 1 : 0)
      }
    }
    groups.value = GROUPS
  } catch (err) {
    errText.value = err instanceof Error ? err.message : String(err)
  } finally {
    loading.value = false
  }
}

onMounted(load)

const saving = ref(false)
const okText = ref('')

async function save(): Promise<void> {
  if (saving.value) return
  errText.value = ''
  okText.value = ''
  const body: Record<string, number> = {}
  for (const g of GROUPS) {
    for (const f of g.fields) {
      const raw = String(draft[f.key] ?? '').trim()
      if (raw === '') {
        errText.value = `字段 ${String(f.key)} 不能为空`
        return
      }
      const n = Number(raw)
      if (!Number.isFinite(n)) {
        errText.value = `字段 ${String(f.key)} 不是数字`
        return
      }
      body[f.key] = f.isFloat
        ? n
        : f.factor > 0
          ? Math.round(n * f.factor)
          : BOOLEAN_KEYS.has(String(f.key))
            ? (n > 0 ? 1 : 0)
            : Math.round(n)
    }
  }
  saving.value = true
  try {
    const applied = await patchSettings(body)
    okText.value = `已保存并应用到 ${applied} 个池`
    await load()
  } catch (err) {
    errText.value = err instanceof Error ? err.message : String(err)
  } finally {
    saving.value = false
  }
}

defineOptions({ name: 'SettingsView' })
</script>

<template>
  <div>
    <div class="page_head">
      <h2>设置</h2>
      <span v-if="okText" class="state_ok">{{ okText }}</span>
    </div>

    <p v-if="errText" class="error">{{ errText }}</p>
    <p v-if="loading" class="muted loading_row">加载中…</p>

    <template v-else>
      <div v-for="g in groups" :key="g.title" class="panel_box">
        <h3>{{ g.title }}</h3>
        <div v-for="f in g.fields" :key="f.key" class="settings_row">
          <label :for="`setting_${f.key}`">{{ f.label }}</label>
          <input
            :id="`setting_${f.key}`"
            v-model="draft[f.key]"
            type="number"
            step="any"
            class="settings_input"
          />
          <span class="muted">{{ f.unit }}</span>
        </div>
      </div>

      <div class="save_row">
        <el-button type="primary" :loading="saving" @click="save">保存（应用到全部池）</el-button>
      </div>

      <PasswordBox />
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

  h2 {
    margin: 0;
    font-size: 24px;
    font-weight: 600;
    letter-spacing: -0.02em;
  }
}

.loading_row {
  padding: 24px 0;
}

.error {
  color: var(--err);
  margin: 0 0 12px;
}

.state_ok {
  color: var(--ok);
}

.panel_box {
  background: var(--bg-alt);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  padding: 24px;
  margin: 16px 0;

  h3 {
    margin: 0 0 12px;
    font-size: 15px;
    font-weight: 600;
    color: var(--text-muted);
  }
}

.settings_row {
  display: grid;
  grid-template-columns: minmax(180px, 260px) 160px auto;
  gap: 10px;
  align-items: center;
  margin: 8px 0;

  label {
    color: var(--text-muted);
  }

  .settings_input {
    width: 160px;
    background: var(--bg);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 5px 11px;
    font: inherit;
    font-variant-numeric: tabular-nums;
  }
}

.save_row {
  display: flex;
  gap: 10px;
  margin: 16px 0;
}

@media (max-width: 768px) {
  .settings_row {
    grid-template-columns: 1fr;
    gap: 6px;
  }
}
</style>
