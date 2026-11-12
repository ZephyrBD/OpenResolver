<script setup lang="ts">
defineProps<{ title: string; reason?: string }>()

defineOptions({ name: 'ModulePlaceholder' })
</script>

<template>
  <div class="placeholder_box">
    <el-empty :description="reason || '该模块在后续批次迁移'" />
  </div>
</template>

<style scoped lang="scss">
.placeholder_box {
  padding: 80px 0;
}
</style>
