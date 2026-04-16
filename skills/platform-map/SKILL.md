---
name: platform-map
description: OpenClaw 平台地图。告诉 agent 这栋多 agent 大楼里有哪些办公室、什么时候找谁、何时读 contract、何时写 output、何时使用 system_action，而不是自己发明跨 workspace 协议。
---

# OpenClaw 平台地图

你不是裸跑在文件系统里。你运行在 OpenClaw 的 runtime 平台上，也生活在一栋多 agent 大楼里。

目标只有一个：

- 先找平台已经给你的入口
- 再用平台已经给你的出口
- 先查楼里的地图和办公室分工
- 不要自己挖新洞，不要自己发明新协议

## 先看哪里

优先级固定：

1. `SOUL.md`
2. `inbox/contract.json`
3. `PLATFORM-GUIDE.md`
4. 当前 contract 明确指定的产物路径
5. 你角色专属的结构化 inbox 文件（如 `code_review.json`、`enriched-diagnostics.json`）

如果这些都不存在，通常应该直接 `HEARTBEAT_OK`，而不是扫描整个 workspace。

补充：

- 需要找协作者时，再查 `BUILDING-MAP.md`
- 需要确认显式协作权限时，再查 `COLLABORATION-GRAPH.md`
- 需要理解结果回流时，再查 `RUNTIME-RETURN.md`
- 不要自己去找原始图目录或原始 loop 文件，不要猜 `graphs/`、`agent_graph.json`、`graph_loops.json`

## 结果写到哪里

默认出口有三类：

1. 主结果写到 contract 的 `output` 路径
2. 若当前阶段需要 runtime 明确识别完成/失败，额外写 `outbox/stage_result.json`
3. 若失败或需要补充信息，额外写 `outbox/contract_result.json`

格式：

```json
{"status":"failed|awaiting_input|completed","summary":"一句话摘要","detail":"必要时补充"}
```

## 什么时候调用平台

如果你自己能完成当前 contract，就直接完成，不要多派发。

如果你不确定本地 `read` / `write` / `edit` 这些工具该怎么用，去看已加载的 `platform-tools` skill；工具只负责本地工作，不负责跨 agent 协议。

如果你需要：

- 启动标准任务管道
- 委派给另一个 agent
- 启动 graph-backed loop
- 请求结构化审查
- 唤醒特定 agent 并附带上下文

优先使用：

- `outbox/system_action.json`

不要直接：

- 写别的 agent 的 `inbox/`
- 手动创建别的 workspace 下的文件
- 伪造 delivery
- 自己维护跨 agent 状态

## 这栋楼怎么分工

- bridge 是前台：接待 WebUI / QQ / test 来客，负责回桥与交付
- planner 是规划办公室：复杂任务拆分、建 contract、组织执行
- executor 是执行办公室：完成明确子任务
- researcher 是研究办公室：做检索、研究方向和研究材料
- evaluator 是审查办公室：做代码审查、质量判断、继续/收口决策

你需要厕所、走廊、电话、工单时，不要自己挖：

- 通讯协议
- 状态提交
- 结果回流
- 重试与兜底

这些都属于平台硬路径。

## `system_action` 是什么

`system_action` 是你调用平台硬路径的标准入口。

常见动作：

- `create_task`
- `assign_task`
- `request_review`
- `start_pipeline`
- `advance_pipeline`
- `wake_agent`

精确 JSON 结构和当前限制，去看已加载的 `system-action` skill。

## 协作原则

1. 自己能做就自己做
2. 真的需要协作，再走平台
3. 只传任务摘要、产物路径、必要约束，不要转发整段历史
4. 结果优先让 runtime 自动回流，不要手工搬运
5. 不知道该找谁时，先查 `BUILDING-MAP.md`；要确认当前权限，再查 `COLLABORATION-GRAPH.md`
6. 平台已经投影给你的 graph / loop / return 真值，不要再去猜原始路径或目录名

## 什么时候不要乱用平台

以下情况不要默认派发：

- 你自己就能完成当前任务
- 你只是想把原本能直接完成的事，硬拆成更大的流程
- 你准备把任务目标扩到用户原话之外，或启动与当前任务无关的额外流程
- 当前 contract 没有要求调用别的 agent
- 你只是想“碰碰运气”

注意：

- 如果委派、审查或启动已登记 loop 本来就是完成当前任务的标准平台路径，这不叫“额外加流程”，可以直接走平台

## 最重要的 5 条规则

1. 先看地图和 contract，再行动
2. 主结果写 `output`，阶段完成信号写 `outbox/stage_result.json`，失败说明写 `outbox/contract_result.json`
3. 需要协作时优先写 `outbox/system_action.json`
4. 不直接碰其他 agent 的 workspace
5. 不知道怎么走时，查 skill，不要自造协议
