---
name: platform-tools
description: OpenClaw 平台工具说明。告诉 agent 如何正确使用本地 read/write/edit、结构化 outbox 与 runtime 硬路径，不把工具误用成跨 agent 协议。
---

# OpenClaw 平台工具说明

你有工具，但工具不是协议。

在 OpenClaw 里，要先分清三件事：

- `skill`：告诉你怎么理解和使用系统
- `tool`：让你在当前 workspace 里读写文件、生成内容
- `runtime`：负责搬运、调度、监督、回流和兜底

## 本地工具做什么

常见本地工具：

- `read`
- `write`
- `edit`

这些工具只负责你自己的局部工作：

- 读取 `inbox/contract.json`
- 按需读取 `BUILDING-MAP.md` / `COLLABORATION-GRAPH.md` / `RUNTIME-RETURN.md`
- 读取 `PLATFORM-GUIDE.md`
- 读取 contract 指向的已有产物
- 写主结果到 contract 的 `output`
- 当前阶段需要让 runtime 明确识别完成/失败时，写 `outbox/stage_result.json`
- 写失败/补充信息到 `outbox/contract_result.json`
- 必要时写 `outbox/_manifest.json`

它们不负责：

- 直接通知别的 agent
- 直接写别的 workspace
- 发明新的通讯路径
- 维护全局状态

## 什么时候用本地工具

如果当前 contract 已经明确告诉你：

- 任务是什么
- 产物写到哪里
- 需要参考哪些已有文件

那你就用本地工具完成它，不要额外扩流程。

## 什么时候停手交给 runtime

如果你需要：

- 委派明确子任务
- 请求 evaluator 审查
- 启动或推进 pipeline / loop
- 唤醒别的 agent
- 让结果回到上游会话

不要自己搬文件或捏协议，应该改走：

- `outbox/system_action.json`

精确动作结构看 `system-action` skill。

## 先读哪些文件

工具使用顺序固定：

1. `SOUL.md`
2. `inbox/contract.json`
3. `PLATFORM-GUIDE.md`
4. 需要找协作者时，再看 `BUILDING-MAP.md`
5. 需要确认显式协作权限时，再看 `COLLABORATION-GRAPH.md`
6. 需要理解返回语义时，再看 `RUNTIME-RETURN.md`
7. contract 指定的目标文件

如果没有 contract，就通常应该 `HEARTBEAT_OK`，而不是乱扫目录。

如果这些文档已经给出 graph、loop、return 等平台真值，就直接用这些投影；不要再去猜 `graphs/`、`agent_graph.json`、`graph_loops.json` 之类的原始路径。

## 哪些东西不要碰

普通 agent 默认不要直接碰：

- `/watchdog/*` 管理路由
- admin surfaces
- change-set 执行链
- 原始 graph / loop 文件或你自己猜出来的 graph 目录
- 其他 agent 的 `inbox/` 或 `outbox/`
- `openclaw.json`

这些属于平台或 operator 的地盘。

## 输出规则

- 主结果优先写 contract 的 `output`
- 如果当前任务处于 pipeline / loop stage，或需要 runtime 识别结构化完成，再补 `outbox/stage_result.json`
- 补充状态写 `outbox/contract_result.json`
- 结构化多产物时补一份 `outbox/_manifest.json`

如果一个工具动作不能明确落到这几个出口之一，先停下来，不要自造出口。

## 最重要的 5 条规则

1. `tool` 只做本地工作，`runtime` 才做跨节点搬运
2. 先看 `SOUL` 和 contract，再动工具；需要选人/判权限/看回流时再读对应文档
3. 工具不是通讯协议，不拿 `write` 去假装调度
4. 没有明确授权时，不碰 admin surface 和别的 workspace
5. 不确定时，先查 skill，不要靠猜
