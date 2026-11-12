# Design-md.md · OpenResolver 管理面板视觉唯一依据

> 状态：**待用户定稿**。定稿后本文件是 `docs/frontend/07-视觉规范.md` 指向的唯一设计依据；docs/frontend/Design-md.md（EduMate 泛化稿）保留至重构完成后清理。
> 基因：延续 Playful Color 五色棱镜（`--brand-*` 五色一等公民），重做排版密度、卡片层级、导航形态；主色模型改为 docs/07 的「端级统一强调色」（本面板单管理端 → 单一主色，不再按页轮换）。

---

## 1. 色彩

### 1.1 五色棱镜（保留，一等公民）

```scss
--brand-green:  #0acf83;
--brand-orange: #f24e1e;
--brand-purple: #a259ff;   // 端强调色（管理端主色）
--brand-red:    #ff7262;
--brand-blue:   #1abcfe;
```

### 1.2 中性面板色

```scss
--bg:        #ffffff;
--bg-alt:    #f7f7fa;      // 比 #fafafa 深半档：区块分层更明显
--text:      #0f0f14;
--text-muted:#6e6e78;
--border:    #e5e5ea;
```

### 1.3 两层颜色模型（docs/07 §1）

| 层 | 取值 | 覆盖范围 |
| --- | --- | --- |
| **端强调色** `--accent`（= `--brand-purple`） | 管理端唯一主色，`App.vue` 写入 `data-accent="admin"`，`tokens.scss` 覆写 `--el-color-primary*` | 侧栏激活、主按钮、链接、输入聚焦、图表主系列 |
| **语义状态色** `--brand-*` / `--ok --warn --err` | 固定语义，不跟端色 | 状态标签（账号 ok/冷却/掉线/禁用）、额度条分档、错误提示、五色轮换的指标卡 |

- 语义色派生沿用现面板做法：`color-mix(in srgb, var(--brand-*) 72%, #0f0f14)` 保证文本可读。
- **取消按页轮换 accent**（旧稿 `body[data-page]` 五色轮换废弃）；五色保留在两处：指标卡五色轮换（内容层）、几何插画。

### 1.4 指标卡五色轮换（保留 signature）

统计卡按序轮换五色：顶部 3px 色沿 + 8% 底 tint（`.card:nth-child(5n+k)` 机制迁移为 `MetricRow` 的 `accents` prop）。

## 2. 字体与字号

- 字体栈：`"Inter", "Segoe UI", "Microsoft YaHei", sans-serif`；Inter 可变字体本地打包（`panel/public/fonts/` 迁至 `frontend/src/assets/fonts/`），**不请求 CDN**（docs/07 §5）。
- 正文字号从 15px 提到 **16px**（docs/07 §5 硬值），行高 1.6；UI 文字 weight 500。
- 字号梯度：13 / 15 / 17 / 20 / 24 / 32。页面标题 24（旧 24 保留）；登录标题 32。
- 数字一律 `font-variant-numeric: tabular-nums`（额度、tokens、倒计时列）。

## 3. 圆角与阴影（不变，docs/07 硬值）

| 元素 | 值 |
| --- | --- |
| 卡片 | 12px（`--radius-md`），登录/弹层 20px（`--radius-lg`） |
| 按钮 / 输入 | 8px |
| 标签胶囊 | 999px |
| 阴影 | 仅卡片软阴影 `--shadow-card: 0 8px 24px rgba(15,15,20,.08)`，hover 出现 |

## 4. 密度与间距（重做的重点）

- 间距基数 **8px**：卡片 padding 24、卡间距 16、区块间距 24。
- **表格行高收紧**：th/td padding 由 10/14 改为 **8/12**，表头字号 13、去灰底改透明（层级靠 1px 分隔线，不靠色块）——密度对齐运维面板的「一眼多行」。
- 页头区（标题行 + 动作行）合并为一行 48px：标题左、池下拉与动作按钮右（`margin-left: auto`），砍掉旧版「标题一行 + 动作一行」的两行纵耗。
- 内容区 gutter 32px；**全宽出血，去 `max-width: 1280px` 居中容器**（docs/07 §2 硬约束，旧稿违规项纠正）。

## 5. 导航形态（重做的重点）

- 主侧栏 220px：顶部品牌区（几何 logo + 名称），中部 `el-menu` 行式导航（图标左 + 文字右，42px 行高，胶囊激活态 = `--accent-10` 底 + 强调色字），底部登出（danger 弱化为灰，hover 才现红）。
- **无顶栏**（单管理端无面包屑/角色切换需求，页内 `h2` 即页头——这是对 docs/06「PageHead 上报顶栏」范式在本项目的裁剪，理由：单端面板顶栏只剩登出，独立顶栏纯耗 64px；此裁剪登记进 09 组件清单说明）。
- 断点：≤1080px 侧栏收窄为图标列；≤768px 转顶部横条（docs/07 §9 两档，废 900/640/560 自创断点）。

## 6. 组件视觉

| 组件 | 规格 |
| --- | --- |
| 主按钮 | 强调色填充 + 白字 + 8px 圆角；hover `color-mix 90% bg` 加深，不缩放 |
| 次按钮 | 1.5px 强调色描边 + 强调色字 |
| 危险按钮 | `--err` 描边字色；侧栏登出例外（灰 → hover 红） |
| 输入 | 1.5px 边框、8px 圆角，聚焦 2px 强调色 ring |
| 状态标签 | `ElTag` 胶囊：ok=绿 / 冷却=橙 / 掉线=红 / 禁用=灰；映射集中在 `StatusTag` |
| 额度条 | `el-progress`（废弃手写 SVG）：≤20% 红 / ≤50% 橙 / 其余蓝 |
| 趋势图 | ECharts（canvas，CSP 安全）：柱=蓝（请求）、线=红（错误率），轴文字 11px `--text-muted` |
| 弹层 | `ElDialog`：20px 圆角、24/28 padding、150ms fade+scale 入场、`::backdrop rgba(15,15,20,.35)`；locked 态（密钥明文）拦 Esc |
| 空态 | `ElEmpty` + 五色几何插画（迁移现有 SVG 插画） |

## 7. CSP 与实现约束（设计即约束）

- **零 `<style>` 标签、零内联脚本**：全部样式经构建产物外链 CSS；动态视觉一律 CSS 变量 / class 切换，不写 `:style`。
- EP 组件依赖内联 style 属性者不用于本面板：`el-table`（列宽）、popper 系（弹层定位）→ 表格用手写轻表组件（登记 09），弹层若 popper 被禁则 `ElDialog` 需验证——**定稿前留一个决策点 D-Dialog**：若 `el-dialog` 的 popper 定位触线，降级为 `native dialog` + ElDialog 视觉复刻。
- 动效尊重 `prefers-reduced-motion`。

## 8. 插画

扁平矢量、五色内取 2–3 色、几何形状（圆、圆角方、blob）；禁止写实图与非品牌渐变（docs/07 §7）。登录页插画与空态插画沿用现稿几何构图。

## 9. 交付自检（视觉维度）

- [ ] 无 `max-width` 居中容器，全宽出血
- [ ] 主色端级统一，状态色不跟端
- [ ] 断点只有 1080 / 768 两档
- [ ] 颜色只取 tokens.scss 变量（图表配置除外）
- [ ] 构建产物零 `<style>` 标签（grep 自检）
