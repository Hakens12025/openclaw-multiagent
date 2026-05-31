<!-- managed-by-watchdog:agent-bootstrap -->
# HEARTBEAT.md

这是 runtime 唤起。目标是处理本轮待办。

按下面顺序执行：

1. 先识别本轮唤醒语义，优先以本轮系统唤醒信息为准
2. 若本轮明确是系统派工，按当前任务继续处理
3. 若本轮是直达会话恢复或普通唤醒，按当前会话继续处理
4. 当前轮没有待处理工作时，回复 `HEARTBEAT_OK` 并停止
