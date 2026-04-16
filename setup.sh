#!/bin/bash
# setup.sh - Initialize OpenClaw multi-agent system workspace structure
# Run this after cloning the repo to ~/.openclaw

set -e

OPENCLAW_DIR="$HOME/.openclaw"

echo "=== OpenClaw Multi-Agent System Setup ==="
echo ""

# 1. Create workspace directories
echo "[1/4] Creating workspace directories..."
mkdir -p "$OPENCLAW_DIR/workspaces/controller/contracts"
mkdir -p "$OPENCLAW_DIR/workspaces/controller/output"
mkdir -p "$OPENCLAW_DIR/workspaces/controller/deliveries"
mkdir -p "$OPENCLAW_DIR/workspaces/contractor"
mkdir -p "$OPENCLAW_DIR/workspaces/worker-a"
mkdir -p "$OPENCLAW_DIR/workspaces/worker-b"
mkdir -p "$OPENCLAW_DIR/workspaces/worker-c"
mkdir -p "$OPENCLAW_DIR/workspaces/kksl/deliveries"
mkdir -p "$OPENCLAW_DIR/workspaces/researcher"
mkdir -p "$OPENCLAW_DIR/workspaces/evaluator"
mkdir -p "$OPENCLAW_DIR/workspaces/test"
echo "  Done."

# 2. Copy gateway workspace configs (nested .git prevents direct git tracking)
echo "[2/5] Copying gateway workspace configs..."
if [ -f "$OPENCLAW_DIR/workspaces/_configs/gateway-SOUL.md" ]; then
    cp -n "$OPENCLAW_DIR/workspaces/_configs/gateway-SOUL.md" "$OPENCLAW_DIR/workspaces/controller/SOUL.md" 2>/dev/null || true
    cp -n "$OPENCLAW_DIR/workspaces/_configs/gateway-HEARTBEAT.md" "$OPENCLAW_DIR/workspaces/controller/HEARTBEAT.md" 2>/dev/null || true
    echo "  Copied gateway SOUL.md and HEARTBEAT.md to workspaces/controller/"
else
    echo "  Skipped (workspaces/_configs not found)."
fi

# 3. Create symlinks for contractor
echo "[3/5] Creating contractor symlinks..."
if [ -L "$OPENCLAW_DIR/workspaces/contractor/contracts" ]; then
    echo "  contracts symlink already exists, skipping."
else
    ln -sf "$OPENCLAW_DIR/workspaces/controller/contracts" "$OPENCLAW_DIR/workspaces/contractor/contracts"
    echo "  Created: workspaces/contractor/contracts -> workspaces/controller/contracts"
fi

if [ -L "$OPENCLAW_DIR/workspaces/contractor/output" ]; then
    echo "  output symlink already exists, skipping."
else
    ln -sf "$OPENCLAW_DIR/workspaces/controller/output" "$OPENCLAW_DIR/workspaces/contractor/output"
    echo "  Created: workspaces/contractor/output -> workspaces/controller/output"
fi

# 3. Install QQ Bot plugin
echo "[4/5] Installing QQ Bot plugin dependencies..."
if [ -f "$OPENCLAW_DIR/extensions/qqbot/package.json" ]; then
    cd "$OPENCLAW_DIR/extensions/qqbot"
    npm install --silent 2>/dev/null || echo "  Warning: npm install failed (may need Node.js 25+)"
    npm run build --silent 2>/dev/null || echo "  Warning: build failed (non-critical if dist/ exists)"
    cd "$OPENCLAW_DIR"
    echo "  Done."
else
    echo "  Skipped (qqbot plugin not found)."
fi

# 4. Make ssh-tunnel executable
echo "[5/5] Setting up SSH tunnel script..."
if [ -f "$OPENCLAW_DIR/ssh-tunnel.sh" ]; then
    chmod +x "$OPENCLAW_DIR/ssh-tunnel.sh"
    echo "  Made ssh-tunnel.sh executable."
else
    echo "  Skipped (ssh-tunnel.sh not found)."
fi

echo ""
echo "=== Setup Complete ==="
echo ""
echo "Next steps:"
echo "  1. Update API keys in openclaw.json if needed"
echo "  2. Run: openclaw configure"
echo "  3. Run: openclaw gateway run"
echo ""
echo "Dashboards:"
echo "  - WebUI: http://localhost:18789"
echo "  - Watchdog: http://localhost:18789/watchdog/progress?token=<your-token>"
