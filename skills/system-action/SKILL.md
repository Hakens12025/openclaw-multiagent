---
name: system-action
description: OpenClaw 平台协作能力。教 agent 区分「对话」与「系统结构」，识别用户 /system-action 关键词并转成 [ACTION]，用 [ACTION] 标记进入结构（委派、唤醒、启动回路等）。
---

# 平台协作能力

## 对话 vs 结构（OpenClaw 核心设计）

OpenClaw 有两种沟通形态，你必须分清：

- **对话（默认）**：用户↔agent、agent↔agent 直接说话。**不建 contract、不进系统结构。**
  你只是在回话，背后没有任何被编织的流程。用户随时可以和系统里任何 agent 说话，
  也可以让某个 agent 去和另一个 agent 说话——这都只是对话。

- **系统结构（system-action）**：进入平台编织的自动化流程的**唯一入口**。
  一旦触发，系统在目标处注入 contract，按图结构自动跑（回路 loop 或线性管线）。
  - 用户触发：`/system-action <target> <任务> [限制N]`
  - agent 触发：在产物里写 `[ACTION] delegate <target> — <任务>`（或 `[ACTION] start_loop`）

**关键**：普通说话绝不会进结构。只有 `/system-action`（用户）/ `[ACTION]`（你）才会启动背后的流程。
agent 之间也可以在与用户对话时发 system-action 给其他 agent，启动自己所在的回路。

## 用户发来 `/system-action` 时（关键桥接）

`/system-action` 是用户消息里的**指令关键词**（类比 Claude Code 的 ultrathink：它是给你的处理提示，
照常作为对话传到你这里，由**你**识别并转成系统动作——平台本身只把消息原样交给你）。

见到 `/system-action <target> <任务> [限制N]`，按严格指令处理：
1. 解析出 `<target>`、`<任务>`、可选的 `[限制N]`。
2. 立即发对应 `[ACTION]` 把它推给系统：
   - 普通派工 → `[ACTION] delegate <target> — <任务>`
   - `<target>` 是回路入口 → `[ACTION] start_loop`（带 `maxRounds=N`）
3. 这是用户明确的系统派工要求，见到即转结构，优先于普通寒暄。

普通消息（无此关键词）保持默认对话形态。

## [ACTION] 命令

```
[ACTION] wake <agentId> — <理由>          唤醒指定 agent
[ACTION] delegate <agentId> — <任务描述>   委派任务给指定 agent（进结构）
[ACTION] review <agentId> — <审理指示>     请求审理
[ACTION] advance — <理由>                  推进到下一阶段
```

## 回路（loop）控制

- **loop-limit 在开始时定**：启动回路的人（命令的 `[限制N]` 或默认）。回路中的 agent 第一次
  收到消息时可以设 limit；缺省走默认。limit 一经设定即贯穿到收敛（中途延长机制已撤销）。
- **早停权仅属 reviewer**：reviewer 写 `conclude` 裁定即提前收敛回路。早停是 reviewer 的专属能力。
- 回路自带 limit，到达上限会被结构强制优雅收敛，无需你操心。

## 使用规则

- 当前任务能本地完成时先完成本地结果
- 一次最多写一个 [ACTION]（系统只执行第一个）
- 协作结果由 runtime 自动回流，[ACTION] 写在产物末尾即可
- 图边 = 授权：只能委派给与你有图连接的 agent，否则被系统拒绝

## 示例

```markdown
## 研究完成

调研发现以下方向值得深入...

[ACTION] delegate worker — 请根据调研结果实现方案 A
```
