<script setup lang="ts">
import { ref } from 'vue'
import { postJson } from '@/api/request'
import AppSelect from '@/components/common/AppSelect.vue'
import { accountName, displayWithId } from '@/utils/fmt'
import type { OnboardAccount } from '@/api/accounts'

/** Qoder PAT 导入（device flow 已移除）：两个官方入口兼作 region 提示。 */
const emit = defineEmits<{ done: [account: OnboardAccount] }>()

const region = ref<'global' | 'cn'>('global')
const pat = ref('')
const busy = ref(false)
const errText = ref('')
const okText = ref('')

const links: Array<{ region: 'cn' | 'global'; href: string; label: string }> = [
  { region: 'cn', href: 'https://qoder.cn/account/integrations', label: '国内版 · 获取 PAT' },
  { region: 'global', href: 'https://qoder.com/account/integrations', label: '国际版 · 获取 PAT' },
]

async function submit(): Promise<void> {
  if (busy.value) return
  errText.value = ''
  okText.value = ''
  busy.value = true
  try {
    const out = await postJson<{ account: OnboardAccount }>('/api/onboard/qoder', {
      pat: pat.value.trim(),
      region: region.value,
    })
    pat.value = ''
    okText.value = `账号已入库：${displayWithId(accountName(out.account), out.account.id)}`
    emit('done', out.account)
  } catch (err) {
    errText.value = err instanceof Error ? err.message : String(err)
  } finally {
    busy.value = false
  }
}

defineOptions({ name: 'OnboardQoder' })
</script>

<template>
  <div>
    <div class="form_row">
      <a v-for="l in links" :key="l.href" :href="l.href" target="_blank" rel="noopener noreferrer" @click="region = l.region">
        {{ l.label }}
      </a>
    </div>
    <div class="form_row">
      <span class="muted">PAT</span>
      <el-input v-model="pat" type="password" placeholder="粘贴 PAT" show-password class="pat_input" />
      <span class="muted">Region</span>
      <AppSelect v-model="region" :options="[{ label: 'global', value: 'global' }, { label: 'cn', value: 'cn' }]" class="region_select" />
      <el-button type="primary" :loading="busy" @click="submit">导入</el-button>
    </div>
    <p class="muted hint">PAT 以 pt- 开头；Region 必须与 PAT 所属站点一致。</p>
    <p v-if="errText" class="error">{{ errText }}</p>
    <p v-if="okText" class="state_ok">{{ okText }}</p>
  </div>
</template>

<style scoped lang="scss">
.form_row {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.pat_input {
  width: 280px;
}

.region_select {
  width: 110px;
}

.hint {
  margin: 0;
  font-size: 13px;
}

.error {
  color: var(--err);
  margin: 0;
}

.state_ok {
  color: var(--ok);
  margin: 0;
}
</style>
