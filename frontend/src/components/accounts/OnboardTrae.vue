<script setup lang="ts">
import { ref } from 'vue'
import { getJson, postJson } from '@/api/request'
import { accountName, copyText, displayWithId } from '@/utils/fmt'
import type { OnboardAccount } from '@/api/accounts'

/** Trae 接入：生成登录链接 → 浏览器登录 → 粘贴回调 URL 入库。 */
const emit = defineEmits<{ done: [account: OnboardAccount] }>()

const link = ref('')
const flowId = ref<string | null>(null)
const callbackUrl = ref('')
const busy = ref(false)
const errText = ref('')
const okText = ref('')

async function genLink(): Promise<void> {
  errText.value = ''
  okText.value = ''
  try {
    const out = await getJson<{ url: string; flowId: string }>('/api/onboard/trae/link')
    link.value = out.url
    flowId.value = out.flowId
  } catch (err) {
    errText.value = err instanceof Error ? err.message : String(err)
  }
}

async function submitCallback(): Promise<void> {
  if (busy.value) return
  errText.value = ''
  okText.value = ''
  busy.value = true
  try {
    const out = await postJson<{ account: OnboardAccount }>('/api/onboard/trae/callback', {
      flowId: flowId.value,
      callbackUrl: callbackUrl.value.trim(),
    })
    callbackUrl.value = ''
    okText.value = `账号已入库：${displayWithId(accountName(out.account), out.account.id)}`
    emit('done', out.account)
  } catch (err) {
    errText.value = err instanceof Error ? err.message : String(err)
  } finally {
    busy.value = false
  }
}

defineOptions({ name: 'OnboardTrae' })
</script>

<template>
  <div>
    <div class="form_row">
      <el-button @click="genLink">生成登录链接</el-button>
      <a v-if="link" :href="link" target="_blank" rel="noopener noreferrer">{{ link }}</a>
      <el-button v-if="link" size="small" @click="copyText(link)">复制</el-button>
    </div>
    <div class="form_row">
      <el-input v-model="callbackUrl" placeholder="粘贴登录完成后的回调 URL" class="cb_input" />
      <el-button type="primary" :loading="busy" @click="submitCallback">提交回调</el-button>
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

.cb_input {
  flex: 1;
  min-width: 240px;
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
