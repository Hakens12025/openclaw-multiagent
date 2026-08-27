#!/bin/bash
# [兼容壳 2026-08-28 立,vNEXT-stable 后删] 无 ctl 对应命令,不转发
echo "[clean.sh] 已退役: 清理内存态用 /watchdog/reset API(带 token),测试清场由 test-runner 预设自带 session-clean。" >&2
echo "[clean.sh] 本脚本旧逻辑清的是重排前旧路径(已失真),不再执行任何删除。" >&2
exit 1
