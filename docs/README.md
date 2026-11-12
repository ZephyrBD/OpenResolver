# docs · 前端开发通用工作流与规范套件

一套可复用到任意 **Vue 3 + TypeScript + Vite + Element Plus** 前端项目的开发流程与规范文档。从 EduMate 项目的实践泛化而来：**协议机制与工程纪律完整保留，业务专属内容已剥离**。

## 目录结构

```
docs/
├── AGENTS.md                    # 硬规则层（限制 + 要求，前后端通用）
├── agents/
│   ├── WORKFLOW.md              # 流程层：分阶段工作流（闸门按端别映射）
│   ├── adr-template.md          # 模板：架构决策记录
│   ├── stage-report.md          # 模板：阶段报告
│   └── acceptance-checklist.md  # 模板：验收清单
├── frontend/                    # 规范层（前端）：写前端代码时的依据
│   ├── 00-参考与优先级.md … 09-组件清单.md
│   └── Design-md.md             # 视觉唯一依据（Figma — Playful Color）
└── backend/                     # 规范层（后端）：写 Node 网关代码时的依据
    └── 00-参考与优先级.md … 09-模块清单.md
```

## 套件组成

| 文档 | 回答的问题 | 定位 |
| --- | --- | --- |
| [`AGENTS.md`](AGENTS.md) | 什么永远不可以、什么时候必须停下来问、该问几个问题、怎么报告 | **硬规则层**（限制 + 要求，前后端通用） |
| [`agents/WORKFLOW.md`](agents/WORKFLOW.md) | 按什么顺序做、每一步问哪 3 句、产出什么、怎么验收 | **流程层**（分阶段执行，闸门按端别映射） |
| [`agents/adr-template.md`](agents/adr-template.md) 等三份模板 | 决策记录 / 阶段报告 / 验收清单长什么样 | **模板**（运行时复制到 `.workflow/templates/`） |
| [`frontend/`](frontend/00-参考与优先级.md) | 前端代码具体怎么写：目录、SFC、路由、组件库、视觉、数据 | **规范层**（前端写代码时的依据） |
| [`backend/`](backend/00-参考与优先级.md) | 后端代码具体怎么写：目录、上游适配、HTTP 与鉴权、调度、安全、测试 | **规范层**（后端写代码时的依据） |

优先级：`AGENTS.md` > `agents/WORKFLOW.md` > `frontend/` / `backend/` 规范 > 任何 skill 的内置建议。

## 如何在新项目中使用

1. 把整个 `docs/` 拷进新项目，`AGENTS.md` 另拷一份到项目根目录（Agent 入口约定）。
2. 按 `<>` 占位符补齐项目专属内容：
   - **skill 清单**（`agents/WORKFLOW.md` §5.1）：按项目实际安装的 skill 填写；
   - **业务参考源**（`frontend/00`）：原型目录、设计稿、实体文档的路径；
   - **角色/业务域前缀**（`frontend/05`）：`stu / tech / admin` 是示例，按项目域替换；
   - **视觉设计稿**（`frontend/07` / `frontend/Design-md.md`）：指向项目的 Figma 或设计文档；
   - **组件清单**（`frontend/09`）：wrapper 与自研组件按项目实际情况登记。
3. 建立运行时产出目录：把 `docs/agents/` 下的三份模板复制到项目 `.workflow/templates/`，并创建 `.workflow/outputs/`（结构见 `agents/WORKFLOW.md` §7）。
4. 开始第一个模块：从 `agents/WORKFLOW.md` 阶段 0 侦察走起。

## 设计原则

- **规则必须带载体**：每条硬规则都有客观判据，判据不满足就不能进入下一阶段——规则因此是流程闸门，不是建议。
- **编号互引、正文不重复**：`AGENTS.md` 用 `R / Q / A / W / F / X / S` 系列，`WORKFLOW.md` 用 `阶段 / D / G / T / L` 系列，引用只写编号。
- **文档不是更新日志**：规范文档只描述「当前应该怎么做」，不写「原来是什么 → 现在改成什么」。历史查 git。
