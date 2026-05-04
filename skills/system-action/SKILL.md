---
name: system-action
description: OpenClaw 平台协作能力。用于让 agent 通过 [ACTION] 标记请求 runtime 执行委派、审查、唤醒或 loop 动作。
---

# 平台协作能力

需要 runtime 协作时，在产物 markdown 末尾写一个 `[ACTION]` 标记。系统会提取第一个动作并执行。

## 常用命令

```text
[ACTION] wake <agentId> — <理由>
[ACTION] delegate <agentId> — <任务描述>
[ACTION] review <agentId> — <审理指示>
[ACTION] {"type":"assign_task","params":{"targetAgent":"worker","message":"任务描述"}}
```

## 使用边界

- 当前 contract 能本地完成时，直接写结果。
- 需要另一个 agent 协作时，使用 `[ACTION]`。
- 协作结果由 runtime delivery 回流。
- 每轮产物只放一个 `[ACTION]`。

## 产物位置

`[ACTION]` 放在本轮 markdown 产物末尾；主结果仍写 contract 指定的 `output`。
