<script setup lang="ts">
import { computed, ref } from 'vue'
import { getJson } from '@/api/request'
import type { GatewayModel } from '@/types/models'
import { copyText } from '@/utils/fmt'
import AppDialog from '@/components/common/AppDialog.vue'

/** API 接入卡：一张卡 + 按钮开弹层（Base URL 说明 + 3 段 curl 示例）。 */
const dlg = ref<InstanceType<typeof AppDialog> | null>(null)

const base = computed(() => `${location.protocol}//${location.host}`)
const firstModel = ref('zcode/GLM-5.3')

async function open(): Promise<void> {
  dlg.value?.open()
  try {
    const res = await getJson<{ data: GatewayModel[] }>('/api/models')
    if (res.data[0]?.id) firstModel.value = res.data[0].id
  } catch {
    // 模型表取不到就用占位模型名
  }
}

const examples = computed(() => [
  {
    title: '/v1/messages（Anthropic，Claude Code 等客户端直接用）',
    cmd: `curl ${base.value}/v1/messages \\\n  -H "Authorization: Bearer zsk_你的密钥" \\\n  -H "content-type: application/json" \\\n  -d '{"model":"${firstModel.value}","max_tokens":1024,"messages":[{"role":"user","content":"你好"}]}'`,
  },
  {
    title: '/v1/messages 流式（SSE）',
    cmd: `curl ${base.value}/v1/messages \\\n  -H "Authorization: Bearer zsk_你的密钥" \\\n  -H "content-type: application/json" \\\n  -d '{"model":"${firstModel.value}","max_tokens":1024,"stream":true,"messages":[{"role":"user","content":"你好"}]}'`,
  },
  {
    title: '/v1/chat/completions（OpenAI 兼容，stream:true 流式）',
    cmd: `curl ${base.value}/v1/chat/completions \\\n  -H "Authorization: Bearer zsk_你的密钥" \\\n  -H "content-type: application/json" \\\n  -d '{"model":"${firstModel.value}","stream":true,"messages":[{"role":"user","content":"你好"}]}'`,
  },
])

defineOptions({ name: 'ApiAccessCard' })
</script>

<template>
  <div class="panel_box api_box">
    <div class="head_row">
      <span class="muted">Base URL 与 curl 调用示例</span>
      <el-button type="primary" @click="open">API 接入</el-button>
    </div>
    <AppDialog ref="dlg" title="API 接入">
      <p class="muted">
        Base URL：<code>{{ base }}</code>（Anthropic 协议与 OpenAI 协议同端口）；鉴权头
        <code>Authorization: Bearer zsk_…</code>，密钥在上方列表创建。
      </p>
      <div v-for="ex in examples" :key="ex.title" class="api_example">
        <h4>{{ ex.title }}</h4>
        <pre class="code">{{ ex.cmd }}</pre>
        <el-button size="small" class="copy_btn" @click="copyText(ex.cmd)">复制</el-button>
      </div>
      <p class="muted note">不写 stream 字段视为非流式。count_tokens 端点 /v1/messages/count_tokens 可用（Claude Code 会自动调用）。</p>
    </AppDialog>
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
}

.api_example {
  position: relative;
  margin: 10px 0 16px;

  h4 {
    margin: 0 0 6px;
    font-size: 14px;
    font-weight: 600;
  }

  .copy_btn {
    position: absolute;
    top: 26px;
    right: 8px;
  }
}

.code {
  background: var(--bg-alt);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  color: var(--text);
  font: 13px/1.6 ui-monospace, Consolas, monospace;
  overflow-x: auto;
  padding: 10px 14px;
  margin: 0;
  white-space: pre;
}

.note {
  font-size: 13px;
  margin: 0;
}
</style>
