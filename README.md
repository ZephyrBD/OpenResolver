# OpenResolver

把多个 AI 编程订阅通道，统一成一个 **Anthropic + OpenAI 双协议**的本地网关。

[![Node](https://img.shields.io/badge/node-%E2%89%A522-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![Dependencies](https://img.shields.io/badge/runtime%20deps-0-brightgreen)](package.json)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

OpenResolver 把 ZCode、Qoder、Trae、WorkBuddy、华为 CodeArts 等平台的订阅额度，包装成标准的 Claude Code / OpenAI 兼容端点。它只依赖 Node.js 内置模块，无 `npm install`、无数据库、无 Docker，账号与密钥全部落在本地。

> 本项目通过各平台的**非官方接口**工作，仅建议使用你自己的账号，并遵守对应平台的服务条款。

---

## 特性

| 能力 | 说明 |
|---|---|
| 双协议入口 | 原生 Anthropic Messages（含 SSE 流式）+ OpenAI Chat Completions |
| 多上游账号池 | ZCode / Qoder（cn+global）/ Trae / WorkBuddy（cn+global）/ 华为 CodeArts，共 7 个池 |
| 智能调度 | 加权选号、Top-N 候选、粘性会话、额度比例入权重、失败换号、冷却与熔断 |
| 密钥体系 | `zsk_` 前缀、只存 SHA-256、有效期 / 池白名单 / 模型白名单 / IP 白名单 / token 配额 |
| 额度与签到 | 每账号额度明细、自动签到/领取、每日定时补领、ZCode 周末包抢领 |
| 管理面板 | 仪表盘、账号、密钥、设置四页；原生 JS 零构建，支持浏览器内完成账号接入 |
| 安全 | 请求体上限、上游总超时、客户端断开即 abort、忽略伪造 XFF、面板 CSRF + 登录限速 |
| 零依赖 | 仅 Node.js ≥ 22 内置模块，无 npm 运行时依赖 |
| 容器化 | 官方 `Dockerfile`（`node:22-alpine`）+ `docker compose up -d` 一键部署，`data/` 独立挂载 |

---

## 架构

```text
Claude Code / OpenAI SDK / cc-switch
                │
                │  x-api-key / Authorization: Bearer zsk_...
                ▼
┌───────────────────────────────────────────────┐
│                  OpenResolver                 │
│                                               │
│  auth/guard  ──►  routing (<pool>/<model>)    │
│        │                  │                   │
│        │                  ▼                   │
│        │           pools/claim-scheduler      │
│        │                  │                   │
│        │     ┌────────────┼────────────┐      │
│        │     ▼            ▼            ▼      │
│        │  zcode        qoder        trae ...  │
│        │     │            │            │      │
│        └────►└────────────┴────────────┘      │
│                 加权 / 冷却 / 换号 / 熔断       │
└───────────────────────┬───────────────────────┘
                        ▼
             各平台上游 API（非官方）
```

面板与推理面共用同一个端口：`/v1/*`（含 `/v1/pool/balance`）走推理鉴权，其余路径走面板会话。

---

## 快速开始

### 环境要求

- Node.js **≥ 22**（使用内置 `fetch`、`node:test`、`import.meta.dirname`）
- Windows / Linux / macOS 均可；用 Docker 部署则只需 Docker + Compose

### 1. 启动

**方式 A：直接跑（需要 Node ≥ 22）**

```bash
git clone https://github.com/ZephyrBD/OpenResolver.git
cd OpenResolver

# 设置面板管理员密码（首次必须）
node tools/admin-passwd.mjs

# 启动（默认 0.0.0.0:8790）
npm start
# 或 PORT=8790 node server.mjs
```

**方式 B：Docker Compose（推荐，零依赖）**

```bash
git clone https://github.com/ZephyrBD/OpenResolver.git
cd OpenResolver

cp .env.example .env
# 编辑 .env，至少改掉 UGW_ADMIN_PASSWORD

docker compose up -d
docker compose logs -f      # 首次启动看日志确认监听 8790
```

镜像基于 `node:22-alpine`（约 150 MB），零 npm 依赖；`data/` 通过 bind mount 挂进容器，**重建镜像不会丢账号与密钥**。

> `compose` 里 `pull_policy: build` 表示每次 `up` 前重新构建本地镜像，改了代码重跑
> `docker compose up -d` 即可生效，不会去拉远端同名镜像。

### 2. 打开面板接入账号

浏览器访问 <http://127.0.0.1:8790>，登录后到 **账号** 页按池接入：

| 池 | 接入方式 |
|---|---|
| ZCode | 面板「链接登录」，浏览器授权后自动入库；或 `node tools/import-zcode.mjs --from accounts.json` |
| Qoder / Qoder CN | 在 qoder 账号页生成 PAT，面板直接导入；或 `node tools/import-qoder.mjs --pat <pat> [--region cn]` |
| Trae | 面板两段式登录（生成链接 → 粘贴回调）；或 `node tools/trae-login.mjs --link` / `--callback "<url>"` |
| WorkBuddy / WorkBuddy CN | 面板两段式浏览器登录 |
| 华为 CodeArts | 面板两段式 OAuth（华为云账号） |

### 3. 创建网关密钥

```bash
node tools/keygen.mjs --name dev --pools zcode,qoder,trae --expires-days 30
```

也可在面板 **密钥** 页创建。明文只显示一次；密钥库在启动时加载，**新建后需重启网关**。

### 4. 接入客户端

Anthropic 协议（Claude Code、Anthropic SDK）：

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:8790
export ANTHROPIC_AUTH_TOKEN=zsk_...
export ANTHROPIC_MODEL=zcode/GLM-5.3
```

OpenAI 协议（OpenAI SDK、兼容客户端）：

```text
Base URL: http://127.0.0.1:8790/v1
API Key:  zsk_...
Model:    <pool>/<model>，例如 trae/DeepSeek-V4-Flash
```

> `/v1/chat/completions` 目前只支持非流式（`stream:false`）；需要流式请走 Anthropic `/v1/messages`。

---

## API

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/health` | 健康检查，无需鉴权 |
| `GET` | `/v1/models` | 模型列表（按密钥的池白名单过滤） |
| `POST` | `/v1/messages` | Anthropic Messages，支持非流式与 SSE 流式 |
| `POST` | `/v1/messages/count_tokens` | 本地 token 估算（Claude Code 会调用） |
| `POST` | `/v1/chat/completions` | OpenAI Chat Completions（非流式） |
| `GET` | `/v1/pool/balance` | 按池汇总余额接口，输出各池原始额度与账号健康数 |
| `GET` | `/` | 管理面板（`/panel/*`、`/api/*`、`/auth/*`） |

调用示例：

```bash
curl -s -X POST http://127.0.0.1:8790/v1/messages \
  -H "x-api-key: zsk_..." \
  -H "content-type: application/json" \
  -d '{
    "model": "zcode/GLM-5.3",
    "max_tokens": 128,
    "messages": [{"role": "user", "content": "hi"}]
  }'
```

模型 ID 统一为 `<pool>/<model>`，裸模型名会返回 `400`。

---

## 配置

### 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `HOST` / `PORT` | `0.0.0.0` / `8790` | 监听地址与端口 |
| `UGW_DATA_DIR` | `./data` | 数据目录（含账号与密钥，已 gitignore） |
| `UGW_OPEN_MODE` | `1` | 没有密钥时是否仅放行回环地址；`0` 关闭 |
| `UGW_MAX_BODY_BYTES` | `8388608` | 请求体上限（8 MiB） |
| `UGW_MAX_ATTEMPTS` | `3` | 单请求最多换号次数 |
| `UGW_UPSTREAM_TIMEOUT_MS` | `600000` | 单次上游总超时 |
| `UGW_SECURE_COOKIE` | `0` | 面板会话 Cookie 是否加 `Secure`（HTTPS 部署时设 `1`） |
| `ZCODE_UPSTREAM_ORIGIN` | `https://zcode.z.ai` | ZCode 上游地址 |
| `ZCODE_APP_VERSION` | `3.16.3` | ZCode 客户端版本（漂移可能触发 3012） |

调度参数（冷却时长、熔断阈值、自动领取时间、额度折算率等）在面板 **设置** 页修改，持久化到 `data/pool-settings.json`；也支持 `UGW_*` 环境变量作为首次默认值。

### 数据目录

```text
data/
├── admin.json                # 面板管理员 scrypt 哈希
├── keys.json                 # 网关密钥，只有 SHA-256
├── pool-settings.json        # 调度与领取设置
├── pools/<pool>/accounts.json# 上游账号凭证（明文 JWT / refreshToken）
├── usage/YYYY-MM-DD.jsonl    # 按天分片的用量记录
└── claims.json               # 自动领取结果
```

> **`data/` 属于机密**。`pools/*/accounts.json` 里是可直接使用的上游凭证，不要提交、不要外发；备份请整目录打包并妥善保管。

---

## Docker 部署

### 文件构成

| 文件 | 作用 |
|---|---|
| `Dockerfile` | `node:22-alpine` 基础镜像；装 `tzdata`（用量按天分片、签到走本地时区）与 `su-exec`（entrypoint 降权到 `node` 用户）；只拷代码，`data/` 由 `.dockerignore` 排除 |
| `docker-compose.yml` | 端口映射、环境变量、`./data:/app/data` 挂载、healthcheck、日志轮转 |
| `.env.example` | 环境变量模板，复制为 `.env` 使用（`.env` 已 gitignore） |
| `docker-entrypoint.sh` | 以 root 启动时先 `chown -R` 修正挂载目录属主（可用 `PUID`/`PGID` 覆盖默认的 1000），再 `su-exec` 降权；`UGW_ADMIN_PASSWORD` 仅在 `data/admin.json` 不存在时用于初始化 |

### 常用命令

```bash
docker compose up -d                      # 构建并后台启动
docker compose logs -f                    # 跟踪日志
docker compose restart                    # 重启（改环境变量后需要）
docker compose down                       # 停止并删除容器（data/ 保留在宿主）
docker compose up -d --build              # 强制重建镜像
docker compose exec openresolver sh       # 进容器排查
```

### 端口与反代

默认映射到宿主的 `8790`。只给本机用时，把 `docker-compose.yml` 里的端口改成
`127.0.0.1:8790:8790`，避免把面板暴露到公网：

```yaml
ports:
  - "127.0.0.1:8790:8790"
```

宿主端口可改 `.env` 里的 `OR_PORT`。部署在 HTTPS 反向代理之后时，把
`UGW_SECURE_COOKIE=1` 写进 `.env`，否则面板会话 Cookie 不会带 `Secure`。

### 健康检查

镜像内置 `HEALTHCHECK`（30s 间隔，15s 启动宽限），compose 另有一份等价配置；
两者都请求容器内 `/health`：

```bash
docker inspect --format '{{.State.Health.Status}}' openresolver   # healthy
```

### 数据持久化与迁移

所有状态都在宿主的 `./data`（容器内 `/app/data`）：

```bash
tar -czf openresolver-data.tar.gz data/      # 备份
# 换机器：拷走 data/ 覆盖过去，再 docker compose up -d 即可
```

> 镜像只包含网关本体（`*.mjs` 与 `adapters/ auth/ http/ identity/ panel/ pools/ profile/ tools/`）。
> `plugins/opencode/` 是给 OpenCode TUI 用的**客户端插件**，不在镜像里，需单独装到本机。

> 容器内的 `trae` 登录工具依赖 `../data` 路径，镜像里 `/app/data` 与挂载点**刻意重合**，
> 不要随意改 `UGW_DATA_DIR`，否则该工具的临时路径会失配。

### 常见问题

| 现象 | 原因与处理 |
|---|---|
| 启动即退出，日志提示无权限写 `/app/data` | 挂载目录属主不对。entrypoint 会自动 `chown`，若宿主开了 user namespace remapping 需手动改属主 |
| 面板能开但接口 401，且回环也不通 | 没配 `UGW_ADMIN_PASSWORD` 且 `data/admin.json` 不存在；或 `UGW_OPEN_MODE=0` —— 容器内回环无意义，保持默认 `1` |
| 用量记录日期不对 / 签到时间偏移 | 容器与宿主时区不一致，改 `.env` 的 `TZ`（默认 `Asia/Shanghai`） |
| 改了代码但行为没变 | `pull_policy: build` 只在 `up` 时重建，用 `docker compose up -d --build` 强制刷新 |
| 日志占满磁盘 | compose 已配 `json-file` 轮转（`max-size: 10m`，`max-file: 3`），自行改 `logging` 时保留这两项 |

---

## 开发

```bash
npm test                     # node --test test/*.test.js
PORT=8790 node server.mjs    # 本地运行
```

测试策略：上游全部使用**真实 HTTP 桩服务**（`test/helpers/stub.mjs`），不打函数级 mock；SSE 断言按字节比较。

```text
adapters/        Anthropic ↔ OpenAI 协议转换、SSE 解析
auth/            密钥签发、校验、持久化
http/            请求体读取、JSON 响应、SSE 辅助
pools/           各上游池实现、调度器、账号与额度
panel/           管理面板（认证 / API / 静态资源）
profile/         ZCode 官方 system 原文（指纹校验用，勿改）
tools/           账号导入、密钥生成、管理员密码等 CLI
test/            单元与集成测试
```

---

## 免责声明

- 本项目通过非官方接口调用各平台订阅额度，可能违反平台服务条款，存在账号受限风险，请自行评估。
- 仓库不包含任何真实凭证。`data/`、`.env` 等本地文件请勿提交。
- 各平台接口与策略随时可能变化，上游失效时需要更新对应池实现。

## 致谢

部分协议实现移植自以下 MIT 项目，代码中保留了对应出处注释：

- [HITZY2002/codearts2api](https://github.com/HITZY2002/codearts2api)（华为 CodeArts）
- [mmqz/cpa-multi-plugins](https://github.com/mmqz/cpa-multi-plugins)（Trae）
- [CraigKettleman/qodbuddy2pi](https://github.com/CraigKettleman/qodbuddy2pi)（Qoder / WorkBuddy）
- [angusdevgo/ZCode2api](https://github.com/angusdevgo/ZCode2api)（ZCode）

## License

[Apache License 2.0](LICENSE) © 2026 ZephyrBD
