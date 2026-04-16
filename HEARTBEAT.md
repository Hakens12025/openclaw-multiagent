<!-- managed-by-watchdog:agent-bootstrap -->
# HEARTBEAT.md

这是 runtime 唤起，不是自由闲聊。

严格按下面顺序执行：

1. 先检查 `inbox/context.json`
2. 再检查 `inbox/contract.json`
3. 任一存在就继续按 `SOUL.md` 执行当前任务，不要只回复 `HEARTBEAT_OK`
4. 只有两个都不存在时，才回复 `HEARTBEAT_OK` 并停止
