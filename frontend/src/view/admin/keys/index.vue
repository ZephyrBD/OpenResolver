<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { deleteKey, fetchKeys, rotateKey, type KeyRecord } from '@/api/keys'
import { copyText, displayWithId, fmtTime, fmtTokens } from '@/utils/fmt'
import { confirm } from '@/composables/useConfirm'
import AppDialog from '@/components/common/AppDialog.vue'
import CreateKeyPanel from '@/components/keys/CreateKeyPanel.vue'
import ApiAccessCard from '@/components/keys/ApiAccessCard.vue'

const keys = ref<KeyRecord[]>([])
const loading = ref(true)
const errText = ref('')

const createDlg = ref<InstanceType<typeof AppDialog> | null>(null)
const secretDlg = ref<InstanceType<typeof AppDialog> | null>(null)
const secretText = ref('')
let secretReload: (() => void) | null = null

async function reload(): Promise<void> {
  loading.value = true
  errText.value = ''
  try {
    keys.value = await fetchKeys()
  } catch (err) {
    errText.value = err instanceof Error ? err.message : String(err)
  } finally {
    loading.value = false
  }
}

onMounted(reload)

function showSecret(secret: string, reloadFn: () => void): void {
  secretText.value = secret
  secretReload = reloadFn
  secretDlg.value?.open()
}

function secretSaved(): void {
  secretDlg.value?.close()
  if (secretReload) secretReload()
}

function onCreated(secret: string): void {
  createDlg.value?.close() // 关表单弹层 → 叠开 locked 明文弹层（流程在「我已保存」终结）
  showSecret(secret, reload)
}

async function rotate(key: KeyRecord): Promise<void> {
  const ok = await confirm(`确定轮换密钥 ${displayName(key)}？旧明文立即失效。`, { danger: true })
  if (!ok) return
  errText.value = ''
  try {
    const { secret } = await rotateKey(key.id)
    showSecret(secret, reload)
    await reload()
  } catch (err) {
    errText.value = err instanceof Error ? err.message : String(err)
  }
}

async function remove(key: KeyRecord): Promise<void> {
  const ok = await confirm(`确定删除密钥 ${displayName(key)}？使用它的客户端会立即 401。`, { danger: true })
  if (!ok) return
  errText.value = ''
  try {
    await deleteKey(key.id)
    await reload()
  } catch (err) {
    errText.value = err instanceof Error ? err.message : String(err)
  }
}

const displayName = (key: KeyRecord): string => displayWithId(key.name || key.prefix || '未命名', key.id)
const poolsOf = (key: KeyRecord): string => (key.enabledPools || []).join(', ') || '全部'

defineOptions({ name: 'KeysView' })
</script>

<template>
  <div>
    <div class="page_head">
      <h2>密钥</h2>
      <el-button type="primary" @click="createDlg?.open()">创建新密钥</el-button>
    </div>

    <p v-if="errText" class="error">{{ errText }}</p>
    <p v-if="loading" class="muted loading_row">加载中…</p>

    <table v-else-if="keys.length" class="hand_table">
      <thead>
        <tr>
          <th>名称 / ID</th>
          <th>启用池</th>
          <th width="140">过期时间</th>
          <th width="150">创建时间</th>
          <th width="110" class="right">已用 tokens</th>
          <th class="actions_col">操作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="key in keys" :key="key.id">
          <td>
            <div>{{ key.name || key.prefix || '未命名' }}</div>
            <div class="muted mono">{{ key.id }} · {{ key.prefix }}…</div>
          </td>
          <td class="muted">{{ poolsOf(key) }}</td>
          <td class="mono">{{ key.expiresAt ? fmtTime(key.expiresAt) : '永不过期' }}</td>
          <td class="mono">{{ fmtTime(key.createdAt) }}</td>
          <td class="mono right">{{ fmtTokens(key.usedTokens || 0) }}</td>
          <td class="actions_col">
            <el-button size="small" @click="rotate(key)">轮换</el-button>
            <el-button size="small" type="danger" plain @click="remove(key)">删除</el-button>
          </td>
        </tr>
      </tbody>
    </table>
    <el-empty v-else description="还没有密钥——建一把 zsk_ 开头的新钥匙，分配给需要的池" />

    <ApiAccessCard />

    <AppDialog ref="createDlg" title="创建密钥">
      <CreateKeyPanel @created="onCreated" />
    </AppDialog>

    <AppDialog ref="secretDlg" title="新密钥明文（仅此一次）" locked>
      <div class="secret_box">
        <div class="mono secret">{{ secretText }}</div>
        <div class="secret_actions">
          <el-button type="primary" @click="copyText(secretText)">复制</el-button>
          <el-button @click="secretSaved">我已保存</el-button>
        </div>
      </div>
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

.loading_row {
  padding: 24px 0;
}

.error {
  color: var(--err);
  margin: 0 0 12px;
}

.actions_col {
  white-space: nowrap;
}

.right {
  text-align: right;
}

.secret_box {
  background: color-mix(in srgb, var(--brand-orange) 8%, var(--bg));
  border: 1.5px solid var(--brand-orange);
  border-radius: var(--radius-md);
  padding: 16px;
}

.secret {
  font-size: 17px;
  word-break: break-all;
  margin: 0 0 10px;
}

.secret_actions {
  display: flex;
  gap: 10px;
}
</style>
