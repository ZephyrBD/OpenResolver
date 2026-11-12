<script setup lang="ts">
import { reactive, ref } from 'vue'
import { importAccount, type OnboardAccount, type PoolName } from '@/api/accounts'

/** 手动导入账号（仅 zcode）：手工填 JWT 等字段；提交成功回调 close + reload。 */
const props = defineProps<{ pool: PoolName | string; onDone: (account: OnboardAccount) => void }>()
const emit = defineEmits<{ close: [] }>()

const fields = [
  ['label', '标签'],
  ['jwt', 'JWT'],
  ['pat', 'PAT'],
  ['uid', 'UID'],
  ['email', 'Email'],
] as const

const values = reactive<Record<string, string>>({})
const busy = ref(false)
const errText = ref('')

async function submit(): Promise<void> {
  if (busy.value) return
  errText.value = ''
  const body: Record<string, unknown> = {}
  for (const [name] of fields) {
    if (values[name]?.trim()) body[name] = values[name].trim()
  }
  if (body.uid) body.uid = Number(body.uid) || body.uid
  busy.value = true
  try {
    const account = await importAccount(props.pool, body)
    emit('close')
    props.onDone(account)
  } catch (err) {
    errText.value = err instanceof Error ? err.message : String(err)
  } finally {
    busy.value = false
  }
}

defineOptions({ name: 'ManualImportPanel' })
</script>

<template>
  <div>
    <div v-for="[name, placeholder] in fields" :key="name" class="form_row">
      <el-input v-model="values[name]" :placeholder="placeholder" />
    </div>
    <div class="form_row">
      <el-button type="primary" :loading="busy" @click="submit">新增</el-button>
    </div>
    <p v-if="errText" class="error">{{ errText }}</p>
  </div>
</template>

<style scoped lang="scss">
.form_row {
  display: flex;
  align-items: center;
  gap: 10px;

  + .form_row {
    margin-top: 8px;
  }
}

.error {
  color: var(--err);
  margin: 0;
}
</style>
