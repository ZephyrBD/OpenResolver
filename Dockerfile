# syntax=docker/dockerfile:1
# OpenResolver —— 网关运行时零 npm 依赖（Node >= 22）；面板为多阶段构建产物。
# --- 阶段 1：构建面板（pnpm + vite，仅镜像内，不进最终层） ---
FROM node:22-alpine AS panelbuild
WORKDIR /fe
COPY frontend/package.json frontend/pnpm-lock.yaml frontend/pnpm-workspace.yaml ./
COPY frontend/ ./
RUN corepack enable && pnpm install --frozen-lockfile && pnpm build

# --- 阶段 2：网关（零依赖，只需 Node 运行时） ---
FROM node:22-alpine

# su-exec 用于 entrypoint 降权，tzdata 让 usage/YYYY-MM-DD.jsonl 与签到定时器走本地时区
RUN apk add --no-cache tzdata su-exec

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8790 \
    UGW_DATA_DIR=/app/data \
    TZ=Asia/Shanghai

WORKDIR /app

# 只拷代码，data/ 由 .dockerignore 排除，永不进镜像
COPY package.json ./
COPY *.mjs ./
COPY adapters ./adapters
COPY auth ./auth
COPY http ./http
COPY identity ./identity
COPY panel ./panel
COPY pools ./pools
COPY profile ./profile
COPY tools ./tools

# 面板产物：静态服务 publicDir 默认指向 frontend/dist
COPY --from=panelbuild /fe/dist ./frontend/dist

# 数据目录与挂载点保持一致（tools/trae-login.mjs 硬编码 ../data，靠路径重合避开）
RUN mkdir -p /app/data && chown -R node:node /app/data

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

EXPOSE 8790

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8790)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "server.mjs"]
