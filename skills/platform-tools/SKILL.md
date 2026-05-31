---
name: platform-tools
description: OpenClaw 平台工具说明。说明本地 read/write/edit、结构化 outbox 与 runtime 硬路径的分工。
---

# OpenClaw 平台工具说明

在 OpenClaw 里：

- `skill` 说明任务语义和平台使用方式
- `tool` 处理当前 workspace 内的读写与编辑
- `runtime` 负责跨 agent 搬运、调度、监督和回流

## 本地工具做什么

常见本地工具：

- `read`
- `write`
- `edit`

它们服务当前 workspace 和本轮明确给出的路径：

- 读取当前 contract、平台文档和任务引用文件
- 写主结果到本轮 output 路径
- 按本轮系统唤醒提交阶段或最终结果

## 什么时候用本地工具

当前 contract 已经明确任务、输入和产物路径时，用本地工具完成它。

## 什么时候交给 runtime

需要委派、审查、唤醒、loop 推进或结果回到上游会话时，使用 `system-action` skill 的 `[ACTION]` 协议。

## 读取顺序

1. `SOUL.md`
2. 本轮系统唤醒信息和当前会话上下文
3. 本轮明确给出的 contract
4. `PLATFORM-GUIDE.md`
5. 协作时再读 `BUILDING-MAP.md`
6. 权限确认时再读 `COLLABORATION-GRAPH.md`
7. 回流语义时再读 `DELIVERY.md`

## 输出规则

- Write the user-facing artifact requested by the contract.
- Write `outbox/runtime_result.json` for runtime status metadata.
- Runtime consumes status metadata; the user-facing answer lives in the artifact.
