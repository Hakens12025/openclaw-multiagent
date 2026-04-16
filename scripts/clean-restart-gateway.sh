#!/bin/bash
# Clean restart gateway - clear all sessions and state before restart

set -euo pipefail

OC="$HOME/.openclaw"
GATEWAY_LOG="/tmp/openclaw-gateway.log"

gateway_is_listening() {
  lsof -nP -iTCP:18789 -sTCP:LISTEN >/dev/null 2>&1
}

gateway_is_alive() {
  kill -0 "$GATEWAY_PID" 2>/dev/null
}

print_gateway_log_tail() {
  echo "--- gateway log tail ---"
  tail -n 40 "$GATEWAY_LOG" 2>/dev/null || true
  echo "--- end gateway log tail ---"
}

echo "=== OpenClaw Gateway Clean Restart ==="
echo ""

# 1. Kill existing gateway
echo "[1/5] Stopping gateway..."
pgrep -f "openclaw" | xargs kill 2>/dev/null || true
sleep 2

# 2. Clean all agent sessions
echo "[2/5] Cleaning agent sessions..."
find "$OC/agents" -name "*.jsonl" -delete 2>/dev/null || true
find "$OC/agents" -name "sessions.json" -delete 2>/dev/null || true
echo "  → Deleted all session files"

# 3. Clean workspace state
echo "[3/5] Cleaning workspace state..."
rm -f "$OC/workspaces/controller/.watchdog-state.json" 2>/dev/null || true
rm -f "$OC/workspaces/controller/TASK_STATE.md" 2>/dev/null || true
echo "  → Deleted watchdog state"

# 4. Clean inbox/outbox (optional - keeps contracts/deliveries)
echo "[4/5] Cleaning inbox/outbox..."
find "$OC/workspaces/contractor/inbox" -type f -delete 2>/dev/null || true
find "$OC/workspaces/contractor/outbox" -type f -delete 2>/dev/null || true
find "$OC/workspaces/worker/inbox" -type f -delete 2>/dev/null || true
find "$OC/workspaces/worker/outbox" -type f -delete 2>/dev/null || true
echo "  → Cleaned inbox/outbox"

# 5. Start gateway
echo "[5/5] Starting gateway..."
cd "$OC"
openclaw config validate >/dev/null
nohup openclaw gateway run > "$GATEWAY_LOG" 2>&1 &
GATEWAY_PID=$!

READY_STREAK=0
for i in $(seq 1 20); do
  if ! gateway_is_alive; then
    echo ""
    echo "❌ Gateway exited before becoming ready"
    print_gateway_log_tail
    exit 1
  fi

  if gateway_is_listening; then
    READY_STREAK=$((READY_STREAK + 1))
    if [ "$READY_STREAK" -ge 2 ]; then
      break
    fi
  else
    READY_STREAK=0
  fi

  if [ $i -eq 20 ]; then
    echo ""
    echo "❌ Gateway did not become ready within 20s"
    print_gateway_log_tail
    exit 1
  fi

  sleep 1
done

if gateway_is_alive && gateway_is_listening; then
  echo ""
  echo "✅ Gateway started successfully"
  echo "   PID: $GATEWAY_PID"
  echo "   Log: $GATEWAY_LOG"
  echo "   Dashboard: http://localhost:18789/watchdog"
else
  echo ""
  echo "❌ Gateway failed to stay ready"
  print_gateway_log_tail
  exit 1
fi
