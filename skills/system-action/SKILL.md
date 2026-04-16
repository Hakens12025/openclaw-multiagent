---
name: system-action
description: OpenClaw 平台协作能力。教 agent 用 [ACTION] 标记请求系统协作（唤醒、委派、推进等）。
---

# 平台协作能力

需要其他 agent 协助时，在产物 markdown 里写 `[ACTION]` 标记。系统自动提取并执行。

## 可用命令

```
[ACTION] wake <agentId> — <理由>          唤醒指定 agent
[ACTION] delegate <agentId> — <任务描述>   委派任务给指定 agent
[ACTION] review <agentId> — <审理指示>     请求审理
[ACTION] advance — <理由>                  推进到下一阶段
```

## 规则

- 自己能完成就自己完成，不要随意协作
- 一次最多写一个 [ACTION]（系统只执行第一个）
- 协作结果由 runtime 自动回流，不需要手工搬运
- [ACTION] 写在产物末尾即可

## 示例

```markdown
## 研究完成

调研发现以下方向值得深入...

[ACTION] wake worker — 请根据调研结果实现方案 A
```
