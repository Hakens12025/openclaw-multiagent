#!/bin/bash
# Clean restart gateway - clear all sessions and state before restart
#
# 2026-08-24 重写（备忘录150 §教训）：网关由 launchd 服务 ai.openclaw.gateway 托管
# （KeepAlive，pkill 会触发秒级复活）。旧脚本的 pkill+手动 nohup 与 launchd 抢跑，
# 造成双网关进程并存（trace 账 seq fork 事故的温床），且 pgrep -f "openclaw" 会
# 误杀命令行里含 .openclaw 路径的无辜进程（杀过正在跑的 npm test）。
# 现改为：生死全部交给 launchd（bootout → 清理 → bootstrap），脚本自己不起进程。
# 真实日志在 ~/.openclaw/logs/gateway.log（/tmp 那份是历史僵尸）。

set -euo pipefail

OC="$HOME/.openclaw"
LABEL="ai.openclaw.gateway"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
GATEWAY_LOG="$OC/logs/gateway.log"
DOMAIN="gui/$(id -u)"

gateway_is_listening() {
  lsof -nP -iTCP:18789 -sTCP:LISTEN >/dev/null 2>&1
}

port_owner() {
  lsof -nP -iTCP:18789 -sTCP:LISTEN 2>/dev/null | tail -1
}

print_gateway_log_tail() {
  echo "--- gateway log tail ($GATEWAY_LOG) ---"
  tail -n 40 "$GATEWAY_LOG" 2>/dev/null || true
  echo "--- end gateway log tail ---"
}

echo "=== OpenClaw Gateway Clean Restart (launchd) ==="
echo ""

# 1. Stop the launchd service (bootout unloads it; KeepAlive 不再复活)
echo "[1/5] Stopping gateway via launchd..."
if launchctl list "$LABEL" >/dev/null 2>&1; then
  launchctl bootout "$DOMAIN/$LABEL" || true
fi
# 等端口真正释放
for i in $(seq 1 15); do
  gateway_is_listening || break
  sleep 1
done
if gateway_is_listening; then
  echo "❌ 端口 18789 仍被占用，且占用者不是 launchd 服务（可能是手动起的野进程）："
  port_owner
  echo "请手动处置后再跑本脚本——不替你杀不明进程。"
  exit 1
fi
echo "  → stopped, port released"

# 2. Clean all agent sessions
echo "[2/5] Cleaning agent sessions..."
find "$OC/agents" -name "*.jsonl" -delete 2>/dev/null || true
find "$OC/agents" -name "sessions.json" -delete 2>/dev/null || true
echo "  → Deleted all session files"

# 3. Clean control-plane state
echo "[3/5] Cleaning control-plane state..."
rm -f "$OC/control-plane/watchdog-state.json" 2>/dev/null || true
rm -f "$OC/control-plane/task-state.md" 2>/dev/null || true
echo "  → Deleted watchdog state"

# 4. Clean inbox/outbox (optional - keeps contracts/deliveries)
echo "[4/5] Cleaning inbox/outbox..."
find "$OC/workspaces/contractor/inbox" -type f -delete 2>/dev/null || true
find "$OC/workspaces/contractor/outbox" -type f -delete 2>/dev/null || true
find "$OC/workspaces/worker/inbox" -type f -delete 2>/dev/null || true
find "$OC/workspaces/worker/outbox" -type f -delete 2>/dev/null || true
echo "  → Cleaned inbox/outbox"

# 5. Start gateway via launchd（RunAtLoad=true，bootstrap 即启动）
# bootout 后立刻 bootstrap 会撞 I/O error（卸载异步完成中）——退避重试三次
echo "[5/5] Starting gateway via launchd..."
for attempt in 1 2 3; do
  if launchctl bootstrap "$DOMAIN" "$PLIST" 2>/dev/null; then
    break
  fi
  [ "$attempt" -eq 3 ] && { echo "❌ launchctl bootstrap 三次失败"; exit 1; }
  sleep 2
done

READY_STREAK=0
for i in $(seq 1 30); do
  if gateway_is_listening; then
    READY_STREAK=$((READY_STREAK + 1))
    if [ "$READY_STREAK" -ge 2 ]; then
      break
    fi
  else
    READY_STREAK=0
  fi

  if [ $i -eq 30 ]; then
    echo ""
    echo "❌ Gateway did not become ready within 30s"
    print_gateway_log_tail
    exit 1
  fi

  sleep 1
done

SERVICE_PID=$(launchctl list "$LABEL" 2>/dev/null | sed -n 's/.*"PID" = \([0-9]*\).*/\1/p' | head -1)
[ -z "$SERVICE_PID" ] && SERVICE_PID=$(lsof -tiTCP:18789 -sTCP:LISTEN 2>/dev/null | head -1)

echo ""
echo "✅ Gateway started successfully (launchd: $LABEL)"
echo "   PID: $SERVICE_PID"
echo "   Log: $GATEWAY_LOG (stderr: $OC/logs/gateway.err.log)"
echo "   Dashboard: http://localhost:18789/watchdog/"
