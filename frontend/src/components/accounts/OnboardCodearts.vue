<script setup lang="ts">
import { ref } from 'vue'
import { postJson } from '@/api/request'
import { accountName, copyText, displayWithId } from '@/utils/fmt'
import type { OnboardAccount } from '@/api/accounts'

/** CodeArts 接入：授权链接 → 回调入库 / ticket 轮询入库（两条路并存）。 */
const emit = defineEmits<{ done: [account: OnboardAccount] }>()

const link = ref('')
const flowId = ref<string | null>(null)
const callbackUrl = ref('')
const busy = ref(false)
const polling = ref(false)
const errText = ref('')
const okText = ref('')
const actionsVisible = ref(false)

async function genLink(): Promise<void> {
  errText.value = ''
  okText.value = ''
  busy.value = true
  try {
    const out = await postJson<{ authorizeUrl: string; flowId: string }>('/api/onboard/codearts', { action: 'link' })
    link.value = out.authorizeUrl
    flowId.value = out.flowId
    actionsVisible.value = true
  } catch (err) {
    errText.value = err instanceof Error ? err.message : String(err)
  } finally {
    busy.value = false
  }
}

async function submitCallback(): Promise<void> {
  errText.value = ''
  okText.value = ''
  busy.value = true
  try {
    const out = await postJson<{ account: OnboardAccount }>('/api/onboard/codearts', {
      action: 'callback',
      flowId: flowId.value,
      callbackUrl: callbackUrl.value.trim(),
    })
    actionsVisible.value = false
    callbackUrl.value = ''
    okText.value = `账号已入库：${displayWithId(accountName(out.account), out.account.id)}`
    emit('done', out.account)
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
    const out = await postJson<{ pending?: boolean; account?: OnboardAccount }>('/api/onboard/codearts', {
      action: 'poll',
      flowId: flowId.value,
    })
    if (out.pending) {
      errText.value = '登录尚未完成：请先在浏览器完成登录再入库。授权链接 10 分钟内有效。'
      return
    }
    if (out.account) {
      actionsVisible.value = false
      okText.value = `账号已入库：${displayWithId(accountName(out.account), out.account.id)}`
      emit('done', out.account)
    }
  } catch (err) {
    errText.value = err instanceof Error ? err.message : String(err)
  } finally {
    polling.value = false
  }
}

defineOptions({ name: 'OnboardCodearts' })
</script>

<template>
  <div>
    <div class="form_row">
      <el-button :loading="busy" @click="genLink">生成授权链接</el-button>
      <a v-if="link" :href="link" target="_blank" rel="noopener noreferrer">{{ link }}</a>
      <el-button v-if="link" size="small" @click="copyText(link)">复制</el-button>
    </div>
    <div v-if="actionsVisible" class="form_row">
      <el-input v-model="callbackUrl" placeholder="粘贴浏览器回跳的完整 URL（含 code=）" class="cb_input" />
      <el-button :disabled="busy" @click="submitCallback">回调入库</el-button>
      <el-button :loading="polling" @click="poll">ticket 轮询入库</el-button>
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
