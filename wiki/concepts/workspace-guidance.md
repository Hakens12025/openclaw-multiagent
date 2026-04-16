# Workspace Guidance

> Agent 文档层级重构：身份优先，上下文按需加载。

## 是什么

定义 Agent workspace 中文档的组织结构和加载策略：

**文档层级（备忘录73）：**

| 文件 | 内容 | 加载时机 |
|------|------|----------|
| SOUL.md | 我是谁 | 启动时，最先读取 |
| BUILDING-MAP.md | 其他人是谁（黄页） | 按需读取 |
| COLLABORATION-GRAPH.md | 我能主动联系谁 | 按需读取 |
| RUNTIME-RETURN.md | 结果怎么回流 | 按需读取 |
| PLATFORM-GUIDE.md | 平台入口/出口/操作面 | 按需读取 |

**旧模式 vs 新模式：**
- 旧：所有文件启动时全部加载（token 浪费严重）
- 新：身份优先，导航按需（减少常驻 token 开销）

**生成机制：**
- `syncRuntimeWorkspaceGuidance()` 在 Gateway 启动时从运行时真值生成所有文件
- Graph 编辑触发 workspace guidance 重新生成
- workspace-guidance-writer 按角色差异化写入（备忘录97）：执行类 Agent 只获得 SOUL + HEARTBEAT

## 为什么存在

- 所有文件全部加载 = 浪费大量 token + 淹没关键信息
- Agent 在大多数 wake cycle 中不需要知道其他 Agent 的详细信息
- 角色差异化注入：planner 需要全局视图，executor 只需要知道自己该做什么
- 文档从运行时真值生成，保证与实际拓扑一致

## 和谁交互

| 概念 | 关系 |
|------|------|
| [SOUL & Identity](soul-identity.md) | SOUL.md 是层级中的第一优先级 |
| [Graph Edge](graph-edge.md) | Graph 变更触发 guidance 重新生成 |
| [Token Economy](token-economy.md) | 按需加载直接服务于 token 节约 |
| [Building Metaphor](building-metaphor.md) | BUILDING-MAP.md 是大楼的黄页/楼层图 |

## 演化

1. 早期：所有 Agent 加载相同的完整 workspace
2. 备忘录50：引入 BUILDING-MAP.md，从运行时真值生成
3. 备忘录73：文档层级重构，5 个文件的分层设计
4. 备忘录97：workspace-guidance-writer 实现角色差异化（执行 Agent 只拿 SOUL + HEARTBEAT）

## 当前状态

**部分实现。** `syncRuntimeWorkspaceGuidance()` 已在 Gateway 启动时运行。角色差异化注入已实现。BUILDING-MAP 的完整分解（5 个独立文件）尚未全部分别生成。
