---
name: platform-map
description: OpenClaw 平台地图。用于理解多 agent 大楼、办公室分工、contract 输入、结果出口、delivery 与 system_action 协作入口。
---

# OpenClaw 平台地图

OpenClaw 是一栋由 runtime 管理的多 agent 大楼。agent 的工作是读取当前任务真值，使用平台投影的地图和出口完成本轮 contract。

## 先看哪里

优先级固定：

1. `SOUL.md`
2. `inbox/contract.json`
3. `PLATFORM-GUIDE.md`
4. contract 指定的产物路径
5. 角色专属结构化 inbox 文件

按需读取：

- 找协作者时读取 `BUILDING-MAP.md`
- 确认显式协作权限时读取 `COLLABORATION-GRAPH.md`
- 理解交付和回流时读取 `DELIVERY.md`

缺少 `inbox/contract.json` 时，回复 `HEARTBEAT_OK` 并停止。

## 结果写到哪里

默认出口：

1. 主结果写到 contract 的 `output` 路径
2. runtime 需要结构化阶段信号时写 `outbox/stage_result.json`
3. 失败或需要补充信息时写 `outbox/contract_result.json`
4. 多产物交付时写 `outbox/_manifest.json`

最小状态格式：

```json
{"status":"failed|awaiting_input|completed","summary":"一句话摘要","detail":"必要时补充"}
```

## 什么时候调用平台

当前 contract 能本地完成时，直接产出结果。需要跨 agent 协作时，在产物 markdown 里写 `[ACTION]` 标记，由 runtime 消费。

常见协作：

- 委派明确子任务
- 请求结构化审查
- 唤醒特定 agent 并附带上下文
- 启动或推进已登记 loop

动作格式看已加载的 `system-action` skill。

## 这栋楼怎么分工

- bridge 是前台：接待 WebUI / QQ / test 来客，负责回桥与交付。
- planner 是规划办公室：把复杂任务拆成阶段和可执行 contract。
- executor 是执行办公室：完成明确、边界清晰的子任务。
- researcher 是研究办公室：负责检索、材料、假设和研究路线。
- evaluator 是审查办公室：负责质量判断、审查结果和治理裁决。

## 协作原则

1. 先读 contract 和地图，再行动
2. 本地能完成的任务直接完成
3. 跨 agent 协作走 `[ACTION]` 和 runtime delivery
4. 只传任务摘要、产物路径、必要约束
5. 结果由 runtime 自动回流
6. graph / loop / delivery 真值使用平台投影

## 最小心法

1. contract 是当前任务真值
2. graph 是协作权限真值
3. delivery 是结果回流真值
4. skill 是按需读取的方法说明
5. runtime 负责搬运、调度、监督和回流
