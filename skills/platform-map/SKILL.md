---
name: platform-map
description: OpenClaw 平台地图。说明多 agent 大楼里的入口、出口、办公室分工、contract、output 与 system_action 的使用位置。
---

# OpenClaw 平台地图

你运行在 OpenClaw runtime 平台中。目标是沿平台给出的入口、出口完成当前任务。

## 先看哪里

按需读取：

1. `SOUL.md`
2. 本轮系统唤醒信息和当前会话上下文
3. 本轮明确给出的 contract（`inbox/contract.json`）
4. contract 指定的产物路径

上游产物在 `inbox/upstream/<producer>/`，文件清单由平台随 contract 一起递送，不用猜文件名。

## 结果写到哪里

- 主结果写到本轮明确给出的 output 路径
- 阶段完成信号按本轮系统唤醒和平台文档提交
- failure / awaiting_input / completed 这类状态写入当前任务指定的正式结果位置

## 什么时候调用平台

当前任务能在本 workspace 完成时，直接完成并提交结果。

需要其他 agent 或唤醒时，直接调用本轮可用的协作工具（`assign_task` / `wake_agent`），由 runtime 执行协作与回流。工具结果当场返回受理凭证或结构化拒绝。

## 这栋楼怎么分工

- bridge：接待 WebUI / QQ / test 来客，负责回桥与交付
- planner：拆阶段、组织执行计划
- executor：完成明确子任务
- researcher：检索、研究方向和研究材料

## 协作原则

1. 先完成本地可完成部分
2. 需要协作时直接调协作工具，目标由你自己指定
3. 目标写错或参数不合法会当场被结构化拒绝，在同一轮改正重试
4. 结果回流交给 runtime
