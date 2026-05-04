---
name: platform-tools
description: OpenClaw 平台工具说明。用于区分本地 read/write/edit、结构化 outbox、delivery 与 runtime 协作路径。
---

# OpenClaw 平台工具说明

工具负责当前 workspace 内的读写执行；runtime 负责跨 agent 搬运、调度、监督、回流和兜底。

## 本地工具做什么

常见本地工具：

- `read`
- `write`
- `edit`

本地工具用于：

- 读取 `inbox/contract.json`
- 按需读取 `BUILDING-MAP.md`、`COLLABORATION-GRAPH.md`、`DELIVERY.md`
- 读取 `PLATFORM-GUIDE.md`
- 读取 contract 指向的已有产物
- 写主结果到 contract 的 `output`
- 写阶段信号到 `outbox/stage_result.json`
- 写失败或补充状态到 `outbox/contract_result.json`
- 写多产物清单到 `outbox/_manifest.json`

## 什么时候用本地工具

当前 contract 已经给出任务、参考材料和产物路径时，使用本地工具完成任务并写入指定出口。

## 什么时候交给 runtime

需要跨 agent 协作、审查、唤醒、loop 推进或上游回流时，在产物 markdown 里写 `[ACTION]` 标记。runtime 会提取动作并处理 delivery。

精确动作格式看 `system-action` skill。

## 读取顺序

1. `SOUL.md`
2. `inbox/contract.json`
3. `PLATFORM-GUIDE.md`
4. 找协作者时读取 `BUILDING-MAP.md`
5. 判定协作权限时读取 `COLLABORATION-GRAPH.md`
6. 理解交付回流时读取 `DELIVERY.md`
7. contract 指定的目标文件

缺少 contract 时，回复 `HEARTBEAT_OK` 并停止。

## 输出规则

- 主结果写 contract 的 `output`
- 结构化阶段完成写 `outbox/stage_result.json`
- 失败或补充状态写 `outbox/contract_result.json`
- 多产物交付写 `outbox/_manifest.json`
- 协作动作写在产物 markdown 的 `[ACTION]` 标记里

## 最小心法

1. `tool` 做本地工作
2. `runtime` 做跨节点搬运
3. `contract` 给任务和出口
4. `graph` 给协作权限
5. `DELIVERY.md` 给结果回流语义
