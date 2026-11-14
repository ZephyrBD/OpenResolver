<script setup lang="ts">
import { computed } from 'vue'

const props = defineProps<{ status: string }>()

/** 状态文案 → ElTag type 的集中映射（业务资产，docs/frontend/09 StatusTag） */
const MAP: Record<string, { type: 'success' | 'warning' | 'danger' | 'info' | 'primary'; label: string }> = {
  ok: { type: 'success', label: '正常' },
  needs_login: { type: 'danger', label: '需登录' },
  cooling: { type: 'warning', label: '冷却中' },
  disabled: { type: 'info', label: '已禁用' },
  degraded: { type: 'warning', label: '降级' },
}

const resolved = computed(() => MAP[props.status] ?? { type: 'info' as const, label: props.status })

defineOptions({ name: 'StatusTag' })
</script>

<template>
  <el-tag :type="resolved.type" round>{{ resolved.label }}</el-tag>
</template>
