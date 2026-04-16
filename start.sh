#!/bin/bash
# OpenClaw Gateway 启动脚本
#
# 网络架构：
#   LLM 出站 → Clash Verge TUN (mixed-port 7897)
#   QQ 入站  → SSH 反向隧道 (-R 云服务器 → 本机)
#
# 前置条件：
#   1. Clash Verge 在 TUN 模式运行
#   2. Clash TUN 配置 route-exclude-address 包含云服务器 IP
#      （Clash Verge → Settings → TUN → route-exclude-address → 添加 YOUR_REMOTE_HOST/32）
#
# 用法: bash ~/.openclaw/start.sh

set -euo pipefail

OPENCLAW_DIR="$HOME/.openclaw"
OPENCLAW_NODE_CA_BUNDLE="${OPENCLAW_NODE_CA_BUNDLE:-$OPENCLAW_DIR/certs/system-roots.pem}"
OPENCLAW_CA_REFRESH_SCRIPT="$OPENCLAW_DIR/scripts/refresh-system-ca-bundle.sh"

# Load deployment profile
PROFILE="${OPENCLAW_PROFILE:-$OPENCLAW_DIR/profiles/default.env}"
[ -f "$PROFILE" ] && source "$PROFILE"

GATEWAY_PORT="${OPENCLAW_GATEWAY_PORT:-18789}"
LOG_DIR="${OPENCLAW_LOG_DIR:-/tmp}"
FORCED_BIND_HOST="${OPENCLAW_GATEWAY_FORCE_BIND_HOST:-127.0.0.1}"

# ── 代理配置 ──────────────────────────────────────────────────────────────────
# 优先使用 Clash (7897)，回退到 SSH 隧道 (8080)
CLASH_PORT=7897
SSH_PROXY_PORT="${OPENCLAW_PROXY_PORT:-8080}"

detect_proxy_port() {
    if lsof -nP -iTCP:${CLASH_PORT} -sTCP:LISTEN >/dev/null 2>&1; then
        echo "$CLASH_PORT"
    elif lsof -nP -iTCP:${SSH_PROXY_PORT} -sTCP:LISTEN >/dev/null 2>&1; then
        echo "$SSH_PROXY_PORT"
    else
        echo "$CLASH_PORT"  # 默认 Clash，TUN 模式不一定有 LISTEN
    fi
}

# ── SSH 隧道配置（仅反向隧道，用于 QQ）─────────────────────────────────────────
SSH_REMOTE_HOST="${OPENCLAW_SSH_REMOTE_HOST:-YOUR_REMOTE_HOST}"
SSH_REMOTE_USER="${OPENCLAW_SSH_REMOTE_USER:-root}"
SSH_REMOTE_PORT="${OPENCLAW_SSH_REMOTE_PORT:-18791}"
SSH_TUNNEL_SCRIPT="$OPENCLAW_DIR/ssh-tunnel.sh"
SSH_SERVICE_SCRIPT="$OPENCLAW_DIR/scripts/ssh-tunnel-service.sh"
SSH_LOG="$LOG_DIR/openclaw-ssh-tunnel.log"
GATEWAY_LOG="$OPENCLAW_DIR/logs/gateway.log"

# ── NO_PROXY：不走代理的地址（本地 + 国内直连厂商）────────────────────────────
NO_PROXY_LIST="localhost,127.0.0.1,::1,open.feishu.cn,.feishu.cn,open.larksuite.com,.larksuite.com,.volces.com,ark.cn-beijing.volces.com"

# ── 工具函数 ──────────────────────────────────────────────────────────────────
gateway_is_listening() {
    lsof -nP -iTCP:${GATEWAY_PORT} -sTCP:LISTEN >/dev/null 2>&1
}

gateway_is_healthy() {
    openclaw health --json --timeout 5000 >/dev/null 2>&1
}

stop_listener() {
    local port="$1"
    local pids
    pids="$(lsof -tiTCP:${port} -sTCP:LISTEN 2>/dev/null || true)"
    if [ -n "$pids" ]; then
        kill $pids 2>/dev/null || true
    fi
}

refresh_node_ca_bundle() {
    if [ -x "$OPENCLAW_CA_REFRESH_SCRIPT" ]; then
        "$OPENCLAW_CA_REFRESH_SCRIPT" "$OPENCLAW_NODE_CA_BUNDLE" >/dev/null
    fi
    if [ -f "$OPENCLAW_NODE_CA_BUNDLE" ]; then
        export NODE_EXTRA_CA_CERTS="$OPENCLAW_NODE_CA_BUNDLE"
    fi
}

test_ssh_connectivity() {
    ssh -o ConnectTimeout=3 -o StrictHostKeyChecking=no -o BatchMode=yes \
        ${SSH_REMOTE_USER}@${SSH_REMOTE_HOST} "echo ok" >/dev/null 2>&1
}

# ══════════════════════════════════════════════════════════════════════════════
# 开始
# ══════════════════════════════════════════════════════════════════════════════

echo "[start] Stopping existing processes..."
openclaw gateway stop >/dev/null 2>&1 || true
if [ -x "$SSH_SERVICE_SCRIPT" ]; then
    bash "$SSH_SERVICE_SCRIPT" stop >/dev/null 2>&1 || true
fi
pkill -f "ssh -R ${SSH_REMOTE_PORT}:localhost:${GATEWAY_PORT}" 2>/dev/null || true
stop_listener "$GATEWAY_PORT"
sleep 2

rm -f "$SSH_LOG"

# 0. Preflight
echo "[start] Refreshing Node CA bundle..."
refresh_node_ca_bundle
echo "[start] Validating config..."
openclaw config validate >/dev/null

# 1. 检测代理
PROXY_PORT=$(detect_proxy_port)
echo "[start] Proxy: 127.0.0.1:${PROXY_PORT} ($([ "$PROXY_PORT" = "$CLASH_PORT" ] && echo "Clash" || echo "SSH tunnel"))"

# 2. SSH 反向隧道（QQ 入站）
SSH_TUNNEL_OK=false
if test_ssh_connectivity; then
    echo "[start] SSH to ${SSH_REMOTE_HOST} OK, starting reverse tunnel..."
    # 只需要 -R（反向隧道给 QQ），不再需要 -L（LLM 走 Clash）
    nohup ssh -R ${SSH_REMOTE_PORT}:localhost:${GATEWAY_PORT} \
        -N -T \
        -o ServerAliveInterval=60 \
        -o ServerAliveCountMax=3 \
        -o ExitOnForwardFailure=yes \
        -o StrictHostKeyChecking=no \
        ${SSH_REMOTE_USER}@${SSH_REMOTE_HOST} \
        >> "$SSH_LOG" 2>&1 &
    SSH_PID=$!
    sleep 2
    if kill -0 $SSH_PID 2>/dev/null; then
        SSH_TUNNEL_OK=true
        echo "[start] SSH reverse tunnel started (PID $SSH_PID)"
    else
        echo "[start] WARNING: SSH tunnel exited immediately"
    fi
else
    echo "[start] WARNING: Cannot SSH to ${SSH_REMOTE_HOST}"
    echo "  → QQ bot 不可用"
    echo "  → 可能原因：Clash TUN 劫持了 SSH 流量"
    echo "  → 修复：Clash Verge → TUN 设置 → route-exclude-address 添加 ${SSH_REMOTE_HOST}/32"
fi

# 3. 启动 Gateway（install + start，launchd 管理 agent lifecycle）
echo "[start] Installing OpenClaw Gateway service..."
cd "$OPENCLAW_DIR"

# 先停旧实例
openclaw gateway stop >/dev/null 2>&1 || true

# install 写入 launchd plist（带 proxy env）
NO_PROXY="$NO_PROXY_LIST" \
    no_proxy="$NO_PROXY_LIST" \
    HTTPS_PROXY="http://127.0.0.1:${PROXY_PORT}" \
    HTTP_PROXY="http://127.0.0.1:${PROXY_PORT}" \
    OPENCLAW_GATEWAY_FORCE_BIND_HOST="$FORCED_BIND_HOST" \
    openclaw gateway install --force --port "${GATEWAY_PORT}" >/dev/null

echo "[start] Starting OpenClaw Gateway service..."
openclaw gateway start >/dev/null

# 4. 等待 Gateway 就绪
for i in $(seq 1 20); do
    if gateway_is_listening; then
        echo "[start] Gateway ready!"
        break
    fi
    if [ $i -eq 20 ]; then
        echo "[start] ERROR: Gateway not ready after 20s"
        tail -n 30 "$GATEWAY_LOG" 2>/dev/null || true
        exit 1
    fi
    sleep 1
done

# 5. 状态汇总
echo ""
echo "══════════════════════════════════"
echo " OpenClaw Status"
echo "══════════════════════════════════"
echo " Gateway:     ✓ listening on :${GATEWAY_PORT}"
echo " Proxy:       127.0.0.1:${PROXY_PORT} ($([ "$PROXY_PORT" = "$CLASH_PORT" ] && echo "Clash Verge" || echo "SSH tunnel"))"
echo " SSH tunnel:  $([ "$SSH_TUNNEL_OK" = true ] && echo "✓ reverse tunnel active" || echo "✗ not connected (QQ unavailable)")"
echo " Dashboard:   http://localhost:${GATEWAY_PORT}/watchdog/progress"
echo " Logs:        $GATEWAY_LOG"
echo "══════════════════════════════════"

if [ "$SSH_TUNNEL_OK" = false ]; then
    echo ""
    echo "⚠  QQ 连接不可用。修复步骤："
    echo "   1. 打开 Clash Verge → Settings → TUN"
    echo "   2. 在 route-exclude-address 添加: ${SSH_REMOTE_HOST}/32"
    echo "   3. 重新运行 bash ~/.openclaw/start.sh"
fi
