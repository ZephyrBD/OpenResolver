<script setup lang="ts">
import { ref } from 'vue'
import { postJson } from '@/api/request'
import AppSelect from '@/components/common/AppSelect.vue'
import { accountName, copyText, displayWithId } from '@/utils/fmt'
import type { OnboardAccount } from '@/api/accounts'

/** WorkBuddy 接入：region + 登录链接 + 轮询入库（登录链接 10 分钟内有效）。 */
const emit = defineEmits<{ done: [account: OnboardAccount] }>()

const region = ref<'global' | 'cn'>('global')
const link = ref('')
const flowId = ref<string | null>(null)
const busy = ref(false)
const polling = ref(false)
const errText = ref('')
const okText = ref('')

async function genLink(): Promise<void> {
  errText.value = ''
  okText.value = ''
  busy.value = true
  try {
    const out = await postJson<{ loginUrl: string; flowId: string }>('/api/onboard/workbuddy', {
      region: region.value,
      action: 'link',
    })
    link.value = out.loginUrl
    flowId.value = out.flowId
  } catch (err) {
    errText.value = err instanceof Error ? err.message : String(err)
  } finally {
    busy.value = false
  }
}

async function poll(): Promise<void> {
  errText.value = ''
  okText.value = ''
  polling.value = true
  try {
    const out = await postJson<{ pending?: boolean; account?: OnboardAccount }>('/api/onboard/workbuddy', {
      region: region.value,
      action: 'poll',
      flowId: flowId.value,
    })
    if (out.pending) {
      errText.value = '登录尚未完成：请先在浏览器完成登录再入库。登录链接 10 分钟内有效。'
      return
    }
    if (out.account) {
      link.value = ''
      okText.value = `账号已入库：${displayWithId(accountName(out.account), out.account.id)}`
      emit('done', out.account)
    }
  } catch (err) {
    errText.value = err instanceof Error ? err.message : String(err)
  } finally {
    polling.value = false
  }
}

defineOptions({ name: 'OnboardWorkbuddy' })
</script>

<template>
  <div>
    <div class="form_row">
      <span class="muted">Region</span>
      <AppSelect v-model="region" :options="[{ label: 'cn', value: 'cn' }, { label: 'global', value: 'global' }]" class="region_select" />
      <el-button :loading="busy" @click="genLink">生成登录链接</el-button>
    </div>
    <div v-if="link" class="form_row">
      <a :href="link" target="_blank" rel="noopener noreferrer">{{ link }}</a>
      <el-button size="small" @click="copyText(link)">复制</el-button>
      <el-button type="primary" :loading="polling" @click="poll">我已登录，入库</el-button>
    </div>
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

.region_select {
  width: 110px;
}

.error {
  color: var(--err);
  margin: 0;
  word-break: break-all;
}

.state_ok {
  color: var(--ok);
  margin: 0;
}
</style>
