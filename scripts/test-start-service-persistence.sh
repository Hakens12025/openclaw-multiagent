#!/bin/bash

set -euo pipefail

OPENCLAW_DIR="${OPENCLAW_DIR:-$HOME/.openclaw}"
PROFILE="${OPENCLAW_PROFILE:-$OPENCLAW_DIR/profiles/default.env}"
[ -f "$PROFILE" ] && source "$PROFILE"

MODE="${1:-check}"
GATEWAY_PORT="${OPENCLAW_GATEWAY_PORT:-18789}"
PROXY_PORT="${OPENCLAW_PROXY_PORT:-8080}"
TUNNEL_LABEL="${OPENCLAW_SSH_TUNNEL_LABEL:-ai.openclaw.ssh-tunnel}"

stop_listener() {
    local port="$1"
    local pids
    pids="$(lsof -tiTCP:${port} -sTCP:LISTEN 2>/dev/null || true)"
    if [ -n "$pids" ]; then
        kill $pids 2>/dev/null || true
        sleep 1
    fi
}

stop_services() {
    openclaw gateway stop >/dev/null 2>&1 || true
    launchctl bootout "gui/$(id -u)/${TUNNEL_LABEL}" >/dev/null 2>&1 || true
    pkill -f "ssh -R .*localhost:${GATEWAY_PORT}" 2>/dev/null || true
    stop_listener "${GATEWAY_PORT}"
    stop_listener "${PROXY_PORT}"
    sleep 2
}

check_service_state() {
    echo "[check] verifying tunnel listener on :${PROXY_PORT}"
    lsof -nP -iTCP:${PROXY_PORT} -sTCP:LISTEN >/dev/null

    echo "[check] verifying gateway listener on :${GATEWAY_PORT}"
    lsof -nP -iTCP:${GATEWAY_PORT} -sTCP:LISTEN >/dev/null

    echo "[check] verifying gateway RPC health"
    openclaw health --json --timeout 5000 >/dev/null
}

case "${MODE}" in
    start)
        echo "[start] stopping pre-existing services"
        stop_services
        echo "[start] running ${OPENCLAW_DIR}/start.sh"
        bash "${OPENCLAW_DIR}/start.sh"
        ;;
    check)
        check_service_state
        echo "[check] persistence verification passed"
        ;;
    *)
        echo "Usage: $0 {start|check}" >&2
        exit 2
        ;;
esac
