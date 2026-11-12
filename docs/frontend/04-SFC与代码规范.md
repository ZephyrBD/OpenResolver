# 04 · SFC 与代码规范

## 1. SFC 块顺序

每个 `.vue` 文件严格按以下顺序，块之间空一行：

```vue
<template>
  <!-- 只在这里写 HTML -->
</template>

<script setup lang="ts">
// 组件逻辑
</script>

<style scoped lang="scss">
// 组件样式
</style>
```

- 统一使用 `<script setup lang="ts">`，不写 Options API，不用 `defineComponent` 包裹页面。
- 无样式就不写 `<style>`；有样式默认 `<style scoped lang="scss">`。
- 模板只写在 `<template>` 里；不要在 `.ts` 里拼 HTML 字符串或写 render 函数。
  - 例外：图表库 tooltip 的配置字符串（`<br/>`、`<b>`）属于图表配置，可保留。
- 组件用 `defineOptions({ name: 'XxxYyy' })` 声明名字，与文件名一致。

## 2. import 顺序与路径

```ts
// 1. vue
import { computed, ref } from 'vue'
// 2. vue-router
import { useRoute } from 'vue-router'
// 3. element-plus
import { ElMessage } from 'element-plus'
import { ArrowLeft } from '@element-plus/icons-vue'
// 4. 本地组件
import ElButton from '@/components/el/ElButton.vue'
// 5. store / composables / api / types
import { usePager } from '@/composables/usePager'
import { studentStore } from '@/store/student'
import type { Paper } from '@/types/models'
```

组内按字母排序。纯类型导入用 `import type { ... } from '...'`。

### import 路径：一律 `@/` 别名（硬约束）

**禁止 `./` 与 `../` 相对路径**，包括：

- SFC 里引组件、composable、store、类型
- `main.ts`、`api/index.ts`、`router/index.ts` 这类入口文件
- 无 `from` 的样式引入（`import '@/styles/tokens.scss'`）

`vite.config.ts` 的 `resolve.alias` 与 `tsconfig.json` 的 `paths` 已配置 `@ → src`，不需要额外配置。**没有例外情况**。

| 场景 | 写法 |
| --- | --- |
| 跨模块引用 | `@/components/el/ElCard.vue` |
| 同模块但跨子目录 | `@/view/stu/courses/components/CourseNav.vue` |
| 模块内 views 引 components | `@/view/stu/courses/components/DocViewDialog.vue` |
| 样式文件 | `import '@/styles/tokens.scss'` |

用别名而不是相对路径的理由：文件移动目录时不用改引用；同一个组件在不同深度的文件里写法一致，`.vue` 与 `.ts` 混排时不会出现 `./` 与 `../` 的层级错乱。

## 3. TypeScript 约定

- `src/` 下脚本文件只允许 `.ts`，**禁止新增 `.js`**（含 `api/`、`router/`、`store/`、`mock/`、`main.ts`）。
- SFC 脚本块必须写 `lang="ts"`，不写裸 `<script setup>`。
- props / emits 用类型写法：

```ts
interface Props {
  title: string
  count?: number
}

const props = withDefaults(defineProps<Props>(), { count: 0 })
const emit = defineEmits<{ change: [value: string] }>()
```

- 外部数据结构（mock、store、接口返回）必须显式声明 `interface` / `type`；跨文件复用的放 `src/types/*.ts`。
- 不使用 `any` 逃逸；确实无法推断时用 `unknown` 并在使用处收窄，或写一行注释说明原因。
- 路由 `meta`、菜单记录等结构用接口约束，不要在调用处反复断言 `as`。
- 组件实例引用用 `ref<InstanceType<typeof X> | null>(null)`。
- 派生数据用 `computed`，不要写进模板表达式。
- 页面不直接调 axios，接口统一放 `src/api/*`，运行态数据放 `src/store/*`。

## 4. SCSS 约定

- `src/` 下样式文件只允许 `.scss`，**禁止新增 `.css`**。
- SFC 样式块必须带 `lang="scss"`，默认 `scoped`。
- **CSS 类名一律蛇形 snake_case**（见 [02 §3](02-目录与文件组织.md)）：

```vue
<style scoped lang="scss">
.answer_sheet {
  padding: 24px;

  &--ok {
    box-shadow: var(--shadow-card);
  }

  .sheet_cell {
    border-radius: var(--radius-sm);
  }
}
</style>
```

- **颜色、圆角、间距只用 CSS 变量**（`var(--accent)`、`var(--radius-md)`）：`App.vue` 通过 `data-accent` 在运行时按端/角色切换主色，Sass 变量会被编译期固化而失效。
- 共享 mixin / function 放 `src/styles/_mixins.scss`、`src/styles/_functions.scss`，用 `@use '@/styles/mixins' as *;` 引入；**禁止 `@import`**（已废弃）。
- 嵌套最多 3 层；能用 `&` 的地方用 `&`。
- `:deep()` 只用于 Element Plus 内部结构与单页特例，通用视觉偏差优先做 wrapper（见 [03 §5](03-组件库与UI库.md)）。
- 媒体查询统一两档：`@media (max-width: 1080px)` / `@media (max-width: 768px)`。
- 改用 Element Plus 后失效的结构类必须删除，不许留死代码。

## 5. 全局结构类

`src/styles/<端>.scss` 只保留 Element Plus 无对等能力的结构类（类名均为 snake_case），例如：

| 类型 | 保留理由 |
| --- | --- |
| 聊天气泡系列（`.chat` / `.msg` / `.who` / `.txt`） | Element Plus 无聊天组件 |
| 答题卡方格网（`.sheet_cell` 系列） | 业务语义（题型分组 × 组内序号 × 多态色） |
| 轻量工具类（`.spacer` / `.muted` / `.dim`） | 布局与文字色工具类 |
| 图表说明小字（`.chart_cap`） | 排版说明文字，`el-text` 过重 |

以下情形**必须删除**：已被 Element Plus 取代的手写表格、按钮、标签、空状态、面板等结构类（`.tbl`、`.btn`、`.tag`、`.empty`、`.panel`、`.stat` 等），不许留死代码。

## 6. 页面里禁止的做法

- 手写表格、按钮、标签、空状态、提示条（见 [03](03-组件库与UI库.md)）。
- 用键盘符号、字符、emoji 当图标（`‹` `→` `✓` `＋` `×` `▶`），必须用 `@element-plus/icons-vue`（见 [03 §3](03-组件库与UI库.md)）。
- 从 `element-plus` 直接 import 模板组件（`ElButton` / `ElTable` 等），必须走 `@/components/el/` wrapper；`ElMessage` 等服务式 API 豁免。
- 在页面里手动调 `setPageHead`，或自己写滚动监听。
- 用 `router.back()` 兜底返回。
- 硬编码 URL，跳转一律用路由名。
- 在页面里重复实现 store 已有的派生逻辑。
- 写死颜色值（图表配置除外）。
- 用 kebab-case 写 CSS 类名（`.sheet-cell`），必须 `.sheet_cell`。
- 写超过 200 行的页面而不拆分（见 [02 §4](02-目录与文件组织.md)）。
- 新建组件前不查重，重复造轮子。

## 7. 相关文档

- [01-技术栈与工程约定](01-技术栈与工程约定.md)
- [02-目录与文件组织](02-目录与文件组织.md)
- [03-组件库与UI库](03-组件库与UI库.md)
- [07-视觉规范](07-视觉规范.md)
