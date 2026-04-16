# Graph & Edge

> agent_graph.json 是协作授权的运行时真值，不是装饰——没有边就不能交互。

## 是什么

`agent_graph.json` 定义 agent 之间的有向协作边。这些边在运行时被强制执行，决定谁能主动联系谁。

**图约束的操作**：
- `assign_task` — 需要 A→B 的显式有向边
- `wake_agent` — 需要 A→B 的显式有向边
- `request_review` — 需要 A→B 的显式有向边
- 违反图约束 → 返回 `invalid_state` + `graph_collaboration_blocked` 警报

**故意不受图约束的操作**：
- `create_task` — controller 接收任务时图可能为空，强制图约束会导致死锁

**关键语义**：
- Edge = **授权**（谁有权主动联系谁），不是时间序列控制
- Pool dispatch 也必须尊重图边（备忘录83 修复：增加 fromAgent 过滤）

**图作为编程语言的类比**（备忘录85）：
- sequential / conditional / loop / function / parallel / stream / race
- 图不仅是静态拓扑，还表达协作模式

**文件演化**：
- 早期 BUILDING-MAP.md 包含 edges 信息
- 备忘录73 将其分解，edges 独立为 COLLABORATION-GRAPH.md

## 为什么存在

- 防止 agent 之间无序通信：没有图约束，任何 agent 都能叫醒任何 agent，系统变成一锅粥
- 运行时安全网：即使 LLM 产生错误的协作指令，图约束也会拦截
- 显式协作拓扑：新加入的开发者 / agent 能立即看懂系统中谁和谁合作

## 和谁交互

- [Three-layer Protocol](./three-layer-protocol.md)：图约束在 L2 Control Plane 执行
- [Conveyor Belt](./conveyor-belt.md)：conveyor dispatch 受图边约束
- [AgentBinding](./agent-binding.md)：EdgeSpec 是 9+1 模型 Assembly 层对象之一
- [Agent Group](./agent-group.md)：组内/组间的边管理（如已存在）

## 演化

1. 备忘录51 确立 graph 为协作真值，强制运行时执行
2. 备忘录83 修复 pool dispatch 未尊重图边的 bug（增加 fromAgent 过滤）
3. 备忘录85 提出图作为编程语言的类比，扩展图的表达能力
4. 备忘录73 将 edges 从 BUILDING-MAP.md 分离为独立文件

## 当前状态

**稳定运行**。运行时图约束已全面生效，pool dispatch 的图感知已实现。`create_task` 的例外是有意为之的设计决策。
