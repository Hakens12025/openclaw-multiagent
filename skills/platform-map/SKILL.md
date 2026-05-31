---
name: platform-map
description: OpenClaw 平台地图。说明多 agent 大楼里的入口、出口、办公室分工、contract、output 与 system_action 的使用位置。
---

# OpenClaw 平台地图

你运行在 OpenClaw runtime 平台中。目标是沿平台给出的入口、出口和图权限完成当前任务。

## 先看哪里

按需读取：

1. `SOUL.md`
2. 本轮系统唤醒信息和当前会话上下文
3. 本轮明确给出的 contract
4. `PLATFORM-GUIDE.md`
5. contract 指定的产物路径

协作相关文档按需读取：

- 找协作者：`BUILDING-MAP.md`
- 确认图权限：`COLLABORATION-GRAPH.md`
- 理解结果回流：`DELIVERY.md`

## 结果写到哪里

- 主结果写到本轮明确给出的 output 路径
- 阶段完成信号按本轮系统唤醒和平台文档提交
- failure / awaiting_input / completed 这类状态写入当前任务指定的正式结果位置

## 什么时候调用平台

当前任务能在本 workspace 完成时，直接完成并提交结果。

需要其他 agent、审查、唤醒或 loop 推进时，使用 `system-action` skill 中的 `[ACTION]` 协议，由 runtime 执行协作与回流。

## 这栋楼怎么分工

- bridge：接待 WebUI / QQ / test 来客，负责回桥与交付
- planner：拆阶段、组织执行计划
- executor：完成明确子任务
- researcher：检索、研究方向和研究材料
- reviewer：审查、质量判断、继续/收口建议

## 协作原则

1. 先完成本地可完成部分
2. 需要协作时查 `BUILDING-MAP.md`
3. 需要确认权限时查 `COLLABORATION-GRAPH.md`
4. 协作动作写 `[ACTION]`
5. 结果回流交给 runtime
