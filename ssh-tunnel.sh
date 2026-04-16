#!/bin/bash

OPENCLAW_DIR="$HOME/.openclaw"

# Load deployment profile
PROFILE="${OPENCLAW_PROFILE:-$OPENCLAW_DIR/profiles/default.env}"
[ -f "$PROFILE" ] && source "$PROFILE"

# SSH隧道配置（profile 可覆盖）
REMOTE_HOST="${OPENCLAW_SSH_REMOTE_HOST:-YOUR_REMOTE_HOST}"
REMOTE_USER="${OPENCLAW_SSH_REMOTE_USER:-root}"
LOCAL_PORT="${OPENCLAW_GATEWAY_PORT:-18789}"
REMOTE_PORT="${OPENCLAW_SSH_REMOTE_PORT:-18791}"
PROXY_PORT="${OPENCLAW_PROXY_PORT:-8080}"
LOG_DIR="${OPENCLAW_LOG_DIR:-/tmp}"
LOG_FILE="$LOG_DIR/openclaw-ssh-tunnel.log"

echo "$(date): 启动SSH隧道..." >> "$LOG_FILE"

# 无限循环，自动重连
while true; do
    echo "$(date): 建立SSH隧道连接..." >> "$LOG_FILE"

    # 建立SSH隧道：
    # -R: 反向隧道，让QQ能通过云服务器访问本地openclaw
    # -L: 本地转发，把本地代理端口映射到云服务器（HTTP CONNECT代理），
    #     使openclaw的出站请求经由云服务器IP（解决QQ IP白名单问题）
    # -N: 不执行远程命令
    # -T: 禁用伪终端分配
    # -o ServerAliveInterval=60: 每60秒发送心跳
    # -o ServerAliveCountMax=3: 最多3次心跳失败后断开
    # -o ExitOnForwardFailure=yes: 端口转发失败时退出
    ssh -R ${REMOTE_PORT}:localhost:${LOCAL_PORT} \
        -L ${PROXY_PORT}:localhost:${PROXY_PORT} \
        -N -T \
        -o ServerAliveInterval=60 \
        -o ServerAliveCountMax=3 \
        -o ExitOnForwardFailure=yes \
        -o StrictHostKeyChecking=no \
        ${REMOTE_USER}@${REMOTE_HOST} \
        >> "$LOG_FILE" 2>&1

    EXIT_CODE=$?
    echo "$(date): SSH隧道断开，退出码: $EXIT_CODE" >> "$LOG_FILE"

    # 等待5秒后重连
    echo "$(date): 5秒后重新连接..." >> "$LOG_FILE"
    sleep 5
done
