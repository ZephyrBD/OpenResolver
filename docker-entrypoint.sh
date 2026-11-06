#!/bin/sh
# 首次启动时把数据目录属主修正为 node（绑定挂载 Windows/宿主机目录时常为 root 属主），再降权运行。
set -e

DATA_DIR="${UGW_DATA_DIR:-/app/data}"
RUN_UID="${PUID:-1000}"
RUN_GID="${PGID:-1000}"

if [ "$(id -u)" = "0" ]; then
  mkdir -p "$DATA_DIR"
  # 账号凭证明文落盘，收紧到 700；只 chown 目录本身，避免大目录递归拖慢启动
  chown -R "$RUN_UID:$RUN_GID" "$DATA_DIR" 2>/dev/null || true
  chmod 700 "$DATA_DIR" 2>/dev/null || true

  # 无交互环境首次部署：容器启动前先跑一次 tools/admin-passwd.mjs，或在这里给 UGW_ADMIN_PASSWORD 兜底
  if [ -n "$UGW_ADMIN_PASSWORD" ] && [ ! -f "$DATA_DIR/admin.json" ]; then
    echo "[entrypoint] 初始化面板管理员密码 -> $DATA_DIR/admin.json"
    su-exec "$RUN_UID:$RUN_GID" node tools/admin-passwd.mjs --password "$UGW_ADMIN_PASSWORD" --data "$DATA_DIR"
  fi

  exec su-exec "$RUN_UID:$RUN_GID" "$@"
fi

exec "$@"
