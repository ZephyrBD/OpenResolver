<script setup lang="ts" generic="T extends Record<string, unknown>">
/**
 * HandTable：ElTable 的 CSP 替代（ElTable 列宽依赖内联 style 属性，触「CSP 优先」裁定）。
 * 登记于组件清单；只承载行渲染，不做分页/排序——需要时再扩。
 */
export interface HandColumn {
  key: string
  label: string
  /** 列宽（HTML width 属性，CSP 全维度零内联） */
  width?: number | string
  align?: 'left' | 'right'
}

defineProps<{
  columns: HandColumn[]
  rows: T[]
  /** 空态文案；空 rows 时整表渲染为空态行 */
  emptyText?: string
}>()

defineSlots<{
  [K in string]: (props: { row: T; value: unknown }) => unknown
}>()

defineOptions({ name: 'HandTable', inheritAttrs: false })
</script>

<template>
  <table class="hand_table" v-bind="$attrs">
    <thead>
      <tr>
        <th
          v-for="col in columns"
          :key="col.key"
          :width="col.width"
          :class="{ right: col.align === 'right' }"
        >
          {{ col.label }}
        </th>
      </tr>
    </thead>
    <tbody>
      <tr v-for="(row, i) in rows" :key="i">
        <td
          v-for="col in columns"
          :key="col.key"
          :class="{ right: col.align === 'right' }"
        >
          <slot :name="`cell_${col.key}`" :row="row" :value="row[col.key]">
            {{ row[col.key] ?? '—' }}
          </slot>
        </td>
      </tr>
      <tr v-if="!rows.length">
        <td :colspan="columns.length">
          <span class="muted">{{ emptyText || '暂无数据' }}</span>
        </td>
      </tr>
    </tbody>
  </table>
</template>

<style scoped lang="scss">
.right {
  text-align: right;
}
</style>
