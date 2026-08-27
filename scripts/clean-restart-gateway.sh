#!/bin/bash
# [兼容壳 2026-08-28 立,vNEXT-stable 后删] 逻辑已收进 openclawctl.js
echo "[clean-restart-gateway.sh] 已迁移: 请改用 node ~/.openclaw/openclawctl.js restart (本壳仅转发)" >&2
exec node "$(dirname "$0")/../openclawctl.js" restart
