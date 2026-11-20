<script setup lang="ts">
import { ref } from 'vue'
import { postJson } from '@/api/request'
import { accountName, displayWithId } from '@/utils/fmt'
import type { OnboardAccount } from '@/api/accounts'

/**
 * ZCode OAuth 两段式（平移旧 autoPollOnboardBox）：
 * 点击同步开空白占位页占住用户手势（await 慢于弹窗拦截窗口时事后 open 会被拦）；
 * 占位页同源 about:blank，先剪断 opener 再外跳；占位被拦 → 失败态出链接兜底。
 */
const emit = defineEmits<{ done: [account: OnboardAccount] }>()

const busy = ref(false)
const errText = ref('')
const okText = ref('')
const fallbackLink = ref('')

let pollTimer: ReturnType<typeof setTimeout> | null = null
let flowId: string | null = null

function stopPoll(): void {
  if (pollTimer) clearTimeout(pollTimer)
  pollTimer = null
}

async function pollTick(): Promise<void> {
  if (!flowId) return
  try {
    const out = await postJson<{ pending?: boolean; status?: string; account?: OnboardAccount; claim?: { status: string; claimed?: string[]; message?: string } }>(
      '/api/onboard/zcode',
      { action: 'poll', flowId },
    )
    // 后端返回 {status:'pending'|'ready', ...}，pending 也可能是 {pending:true}（trae/workbuddy 风格），两者都要继续轮询
    if (out.pending || (out.status && out.status !== 'ready')) {
      pollTimer = setTimeout(pollTick, 2000)
      return
    }
    stopPoll()
    busy.value = false
    if (out.account) {
      const claimMsg = out.claim
        ? out.claim.status === 'claimed'
          ? `；领取：已领 ${out.claim.claimed?.join(', ')}`
          : `；领取：${out.claim.message || out.claim.status}`
        : ''
      okText.value = `账号已入库：${displayWithId(accountName(out.account), out.account.id)}${claimMsg}`
      emit('done', out.account)
    }
  } catch (err) {
    stopPoll()
    busy.value = false
    errText.value = err instanceof Error ? err.message : String(err)
  }
}

async function start(): Promise<void> {
  errText.value = ''
  okText.value = ''
  fallbackLink.value = ''
  busy.value = true
  // 同步开空白占位页占住用户手势；不能带 noopener（拿不到引用），先剪断 opener 再外跳
  const w = window.open('', '_blank')
  if (w) w.opener = null
  try {
    const out = await postJson<{ authorizeUrl: string; flowId: string }>('/api/onboard/zcode', { action: 'link' })
    flowId = out.flowId
    if (w) {
      w.location = out.authorizeUrl
      pollTick()
    } else {
      busy.value = false
      fallbackLink.value = out.authorizeUrl
      errText.value = '弹窗被拦截：请允许本站弹窗，或手动打开下方链接'
    }
  } catch (err) {
    w?.close()
    busy.value = false
    errText.value = err instanceof Error ? err.message : String(err)
  }
}

defineOptions({ name: 'OnboardZcode' })
</script>

<template>
  <div>
    <div class="form_row">
      <el-button type="primary" :disabled="busy" @click="start">打开授权页面</el-button>
      <span v-if="busy" class="muted">等待登录完成…</span>
    </div>
    <p v-if="errText" class="error">{{ errText }}</p>
    <p v-if="fallbackLink">
      <a :href="fallbackLink" target="_blank" rel="noopener noreferrer" class="mono">{{ fallbackLink }}</a>
    </p>
    <p v-if="okText" class="state_ok">{{ okText }}</p>
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
  word-break: break-all;
}

.state_ok {
  color: var(--ok);
  margin: 0;
}
</style>
