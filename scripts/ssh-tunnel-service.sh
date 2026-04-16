#!/bin/bash

set -euo pipefail

OPENCLAW_DIR="${OPENCLAW_DIR:-$HOME/.openclaw}"
PROFILE="${OPENCLAW_PROFILE:-$OPENCLAW_DIR/profiles/default.env}"
[ -f "$PROFILE" ] && source "$PROFILE"

LABEL="${OPENCLAW_SSH_TUNNEL_LABEL:-ai.openclaw.ssh-tunnel}"
PLIST_PATH="$HOME/Library/LaunchAgents/${LABEL}.plist"
SSH_TUNNEL_SCRIPT="$OPENCLAW_DIR/ssh-tunnel.sh"
LOG_DIR="${OPENCLAW_LOG_DIR:-/tmp}"
LAUNCHD_STDOUT="${LOG_DIR}/openclaw-ssh-tunnel.launchd.log"
LAUNCHD_STDERR="${LOG_DIR}/openclaw-ssh-tunnel.launchd.err.log"
LAUNCHD_PATH="${OPENCLAW_SSH_TUNNEL_PATH:-/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin}"

GATEWAY_PORT="${OPENCLAW_GATEWAY_PORT:-18789}"
PROXY_PORT="${OPENCLAW_PROXY_PORT:-8080}"
REMOTE_HOST="${OPENCLAW_SSH_REMOTE_HOST:-YOUR_REMOTE_HOST}"
REMOTE_USER="${OPENCLAW_SSH_REMOTE_USER:-root}"
REMOTE_PORT="${OPENCLAW_SSH_REMOTE_PORT:-18791}"

launchd_domain() {
    printf 'gui/%s' "$(id -u)"
}

service_target() {
    printf '%s/%s' "$(launchd_domain)" "${LABEL}"
}

render_plist() {
    mkdir -p "$(dirname "$PLIST_PATH")"
    mkdir -p "$LOG_DIR"

    cat > "$PLIST_PATH" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${LABEL}</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ProgramArguments</key>
    <array>
      <string>/bin/bash</string>
      <string>${SSH_TUNNEL_SCRIPT}</string>
    </array>
    <key>StandardOutPath</key>
    <string>${LAUNCHD_STDOUT}</string>
    <key>StandardErrorPath</key>
    <string>${LAUNCHD_STDERR}</string>
    <key>EnvironmentVariables</key>
    <dict>
      <key>HOME</key>
      <string>${HOME}</string>
      <key>PATH</key>
      <string>${LAUNCHD_PATH}</string>
      <key>OPENCLAW_DIR</key>
      <string>${OPENCLAW_DIR}</string>
      <key>OPENCLAW_PROFILE</key>
      <string>${PROFILE}</string>
      <key>OPENCLAW_LOG_DIR</key>
      <string>${LOG_DIR}</string>
      <key>OPENCLAW_GATEWAY_PORT</key>
      <string>${GATEWAY_PORT}</string>
      <key>OPENCLAW_PROXY_PORT</key>
      <string>${PROXY_PORT}</string>
      <key>OPENCLAW_SSH_REMOTE_HOST</key>
      <string>${REMOTE_HOST}</string>
      <key>OPENCLAW_SSH_REMOTE_USER</key>
      <string>${REMOTE_USER}</string>
      <key>OPENCLAW_SSH_REMOTE_PORT</key>
      <string>${REMOTE_PORT}</string>
    </dict>
  </dict>
</plist>
EOF
}

start_service() {
    render_plist
    launchctl bootout "$(service_target)" >/dev/null 2>&1 || true
    launchctl bootstrap "$(launchd_domain)" "$PLIST_PATH"
    launchctl kickstart -k "$(service_target)" >/dev/null 2>&1 || true
}

stop_service() {
    launchctl bootout "$(service_target)" >/dev/null 2>&1 || true
}

status_service() {
    launchctl print "$(service_target)"
}

usage() {
    echo "Usage: $0 {start|stop|status}" >&2
}

case "${1:-start}" in
    start)
        start_service
        ;;
    stop)
        stop_service
        ;;
    status)
        status_service
        ;;
    *)
        usage
        exit 2
        ;;
esac
