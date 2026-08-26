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

需要委派、唤醒或让结果回到上游会话时，直接调用本轮可用的协作工具（`assign_task` / `wake_agent`）。工具走不通时才看降级写法（`COLLABORATION-FALLBACK.md`）。

## 读取顺序

1. `SOUL.md`
2. 本轮系统唤醒信息和当前会话上下文
3. 本轮明确给出的 contract（`inbox/contract.json`）
4. 上游产物：`inbox/upstream/<producer>/`，清单随 contract 递送

## 输出规则

- Write the user-facing artifact requested by the contract into `outbox/`.
- 产物写进 `outbox/` 就会被采集，无需额外的提交令牌文件。
- `outbox/runtime_result.json` carries runtime status metadata：只在 `status: failed` 这个平台自身观察不到的状态时写它（缺外部信息也用 failed，reason 写清缺什么）。
- Runtime consumes status metadata; the user-facing answer lives in the artifact.
