#!/bin/bash
#
# ssh-tunnel.sh — LEGACY 独立 SSH 隧道脚本（-R 反向 + -L 正向），自带无限重连循环。
#
# FIX(C9-doc-drift): 两套隧道策略并存无交叉引用 -> 说明分工与真值。
# 与 start.sh 的关系（隧道真值以 start.sh 为准）：
#   - start.sh（当前主路径）：LLM 出站走 Clash Verge TUN(7897)，SSH 仅做 QQ 入站的
#     -R 反向隧道，且把 ssh -R 内联，不再需要 -L（见 start.sh 顶部注释）。
#   - 本脚本（legacy）：QQ IP 白名单时代的老策略——额外用 -L 8080 把出站代理经
#     云服务器转发；当 Clash TUN 可用时 -L 分支已冗余。
# 现状：start.sh 声明了 SSH_TUNNEL_SCRIPT 变量却未调用本脚本；实际拉起隧道的是
#   scripts/ssh-tunnel-service.sh 与 start.sh 内联的 ssh -R。本脚本仅供
#   skills/qqbot-repair 手动排障直接运行（见该 SKILL.md）。
# 后续（非本次改动）：下一个稳定 tag 前应收敛为一条隧道路径，删除冗余 -L 分支。

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
