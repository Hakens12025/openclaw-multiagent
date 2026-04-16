#!/bin/bash
# OpenClaw 环境清理脚本
# 用法: bash ~/.openclaw/clean.sh
# 清理内存状态 + 文件残留，不需要重启网关

set -e

OC="$HOME/.openclaw"
PORT=18789
TOKEN=$(python3 -c "import json; print(json.load(open('$OC/openclaw.json'))['gateway']['auth']['token'])" 2>/dev/null || echo "")

echo "══════════════════════════════════════"
echo " OpenClaw Clean — $(date '+%H:%M:%S')"
echo "══════════════════════════════════════"

# 1. Reset in-memory state via API (if gateway is running)
echo ""
echo "1. Resetting in-memory state..."
RESET=$(curl -s "http://localhost:$PORT/watchdog/reset?token=$TOKEN" 2>/dev/null || echo "OFFLINE")
if [ "$RESET" = "OFFLINE" ]; then
  echo "   Gateway offline, skipping memory reset"
else
  echo "   $RESET"
fi

# 2. Clean contract files
echo ""
echo "2. Cleaning contracts..."
COUNT=$(find "$OC/workspaces/controller/contracts" -name "*.json" 2>/dev/null | wc -l | tr -d ' ')
if [ "$COUNT" -gt 0 ]; then
  rm -f "$OC/workspaces/controller/contracts/"*.json
  echo "   Removed $COUNT contract(s)"
else
  echo "   No contracts to clean"
fi

# 3. Clean delivery files
echo ""
echo "3. Cleaning deliveries..."
COUNT=0
for dir in "$OC/workspaces/controller/deliveries" "$OC/workspaces/kksl/deliveries"; do
  if [ -d "$dir" ]; then
    N=$(find "$dir" -name "*.json" 2>/dev/null | wc -l | tr -d ' ')
    COUNT=$((COUNT + N))
    rm -f "$dir/"*.json
  fi
done
echo "   Removed $COUNT delivery/deliveries"

# 4. Clean output files
echo ""
echo "4. Cleaning output files..."
COUNT=$(find "$OC/workspaces/controller/output" -type f 2>/dev/null | wc -l | tr -d ' ')
if [ "$COUNT" -gt 0 ]; then
  rm -f "$OC/workspaces/controller/output/"*
  echo "   Removed $COUNT output file(s)"
else
  echo "   No output files to clean"
fi

# 5. Clean inbox/outbox
echo ""
echo "5. Cleaning inbox/outbox..."
COUNT=0
for dir in "$OC/workspaces/contractor/inbox" "$OC/workspaces/contractor/outbox" \
           "$OC/workspaces/worker-a/inbox" "$OC/workspaces/worker-a/outbox" \
           "$OC/workspaces/worker-b/inbox" "$OC/workspaces/worker-b/outbox" \
           "$OC/workspaces/worker-c/inbox" "$OC/workspaces/worker-c/outbox"; do
  if [ -d "$dir" ]; then
    N=$(find "$dir" -type f 2>/dev/null | wc -l | tr -d ' ')
    COUNT=$((COUNT + N))
    rm -f "$dir/"*
  fi
done
echo "   Removed $COUNT inbox/outbox file(s)"

# 6. Verify
echo ""
echo "══════════════════════════════════════"
if [ "$RESET" != "OFFLINE" ]; then
  RUNTIME=$(curl -s "http://localhost:$PORT/watchdog/runtime?token=$TOKEN" 2>/dev/null)
  SESSIONS=$(echo "$RUNTIME" | python3 -c "import sys,json; d=json.load(sys.stdin); print(len(d.get('trackingSessions',{})))" 2>/dev/null || echo "?")
  echo " State: $SESSIONS active sessions"
else
  echo " Gateway offline — memory not cleared"
fi
echo " Clean complete."
echo "══════════════════════════════════════"
