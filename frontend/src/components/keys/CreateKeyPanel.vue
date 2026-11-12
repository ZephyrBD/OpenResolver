<script setup lang="ts">
import { computed, ref } from 'vue'
import { POOL_NAMES } from '@/api/accounts'
import { createKey } from '@/api/keys'

/** 创建密钥弹层内容：成功后经 created 交出明文（父组件叠开 locked 明文弹层）。 */
const emit = defineEmits<{ created: [secret: string] }>()

const name = ref('')
const pools = ref<string[]>([])
const expires = ref('')

const busy = ref(false)
const errText = ref('')

const expiresAt = computed(() => (expires.value ? new Date(expires.value).getTime() : undefined))

async function submit(): Promise<void> {
  if (busy.value) return
  errText.value = ''
  busy.value = true
  try {
    const body: { name: string; pools: string[]; expiresAt?: number } = {
      name: name.value.trim(),
      pools: pools.value,
    }
    if (expiresAt.value) body.expiresAt = expiresAt.value
    const { secret } = await createKey(body)
    emit('created', secret)
  } catch (err) {
    errText.value = err instanceof Error ? err.message : String(err)
  } finally {
    busy.value = false
  }
}

defineOptions({ name: 'CreateKeyPanel' })
</script>

<template>
  <div>
    <div class="key_form">
      <label>名称</label>
      <el-input v-model="name" placeholder="名称" />
      <label>启用池</label>
      <div class="pool_checks">
        <el-checkbox-group v-model="pools">
          <el-checkbox v-for="name in POOL_NAMES" :key="name" :value="name" :label="name" />
        </el-checkbox-group>
      </div>
      <label>过期时间</label>
      <div class="key_expiry">
        <input v-model="expires" type="datetime-local" class="expiry_input" />
        <el-button type="primary" :loading="busy" @click="submit">创建</el-button>
      </div>
    </div>
    <p v-if="errText" class="error">{{ errText }}</p>
  </div>
</template>

<style scoped lang="scss">
.key_form {
  display: grid;
  grid-template-columns: 88px minmax(0, 1fr);
  gap: 12px 14px;
  align-items: start;

  > label {
    color: var(--text-muted);
    padding-top: 8px;
  }
}

.pool_checks {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 14px;
}

.key_expiry {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  align-items: center;
}

.expiry_input {
  background: var(--bg);
  color: var(--text);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 5px 11px;
  font: inherit;
}

.error {
  color: var(--err);
  margin: 8px 0 0;
}
</style>
