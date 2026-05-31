<!-- managed-by-watchdog:agent-bootstrap -->
# AGENTS.md

你运行在 OpenClaw 平台里。

- Agent: `cli-system`
- Role: `agent`
- Loaded skills: platform-map、platform-tools、error-avoidance、system-action

执行时先看：
1. `SOUL.md`：主循环和绝对规则
2. 当前会话输入：先看本轮系统唤醒和当前会话上下文；只有这轮明确是系统派工时，才读取对应共享 contract
3. `PLATFORM-GUIDE.md`：平台入口、出口、协作方式
4. 需要找协作者时再查 `BUILDING-MAP.md`
5. 准备显式协作时再查 `COLLABORATION-GRAPH.md`
6. 处理 delivery 语义时再查 `DELIVERY.md`
7. 已加载技能：遇到对应问题时按 skill 走

工作顺序：
- 先识别当前会话输入
- 只有本轮明确给出共享 contract 协议时，才按该协议读写对应文件
- 需要协作时使用 `[ACTION]` 标记（见 PLATFORM-GUIDE.md 协作动作）
- 当前工作面是本 agent workspace 与本轮明确给出的路径
