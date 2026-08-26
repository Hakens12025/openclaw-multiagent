# Workspace Guidance

> Agent 文档层级重构：身份优先，上下文按需加载。

## 是什么

定义 Agent workspace 中文档的组织结构和加载策略：

**文档层级（备忘录73）：**

| 文件 | 内容 | 谁有 |
|------|------|------|
| SOUL.md | 我是谁（**用户自有**，只在缺失时 writeIfMissing） | 全角色 |
| IDENTITY.md | role persona 载体（系统托管，带 marker） | 全角色 |
| COLLABORATION-FALLBACK.md | 工具走不通时的两级标记降级写法 | 仅 bridge / agent |
| HEARTBEAT.md | 空闲轮行为 | 全角色 |
| BUILDING-MAP.md | 其他人是谁（黄页） | 仅 bridge / agent |
| COLLABORATION-GRAPH.md | 固定管线拓扑与我在图上的位置 | 仅 bridge / agent |
| DELIVERY.md | 结果怎么送达 | 仅 bridge / agent |
| PLATFORM-GUIDE.md | 平台入口/出口/操作面 | 仅 bridge / agent |
| AGENTS.md | 本地总引导 | 仅 bridge / agent |

**旧模式 vs 新模式：**
- 旧：所有文件启动时全部加载（token 浪费严重）
- 新：身份优先，导航按需（减少常驻 token 开销）

**生成机制：**
- `syncRuntimeWorkspaceGuidance()` 在 Gateway 启动时从运行时真值生成所有文件
- Graph 编辑触发 workspace guidance 重新生成
- `workspace-guidance-writer.js` 按角色差异化写入：执行层三角色（planner / executor / researcher）只拿 **IDENTITY + HEARTBEAT**（SOUL 用户自有）。`COLLABORATION-FALLBACK.md` 同样被 `isExecutionLayer` 挡住（`writer:193`），而 `AGENTS/BUILDING-MAP/COLLABORATION-GRAPH/DELIVERY/PLATFORM-GUIDE` 五份由 `EXECUTION_LAYER_CLEANUP` **主动删除**

> ⚠️ 由此推出一条硬约束：**任何注给全体 agent 的提示词或 skill，都不能指向 `COLLABORATION-FALLBACK.md` 或那 5 份文档**——对执行层四角色必然扑空。`semantic-skill-registry` 的 `platform-map` 与 `system-action` 都踩过（2026-08-09 已收敛）。降级写法真正可靠的递送面是**结构化拒绝回执本身**：live 实测 planner 只凭拒绝信息就写对了标记。

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
4. 备忘录97：workspace-guidance-writer 实现角色差异化（执行 Agent 只拿最小集）
5. **v179：IDENTITY.md 升为全角色托管的 persona 载体；COLLABORATION-FALLBACK.md 新建**，把标记语法从主提示词里挪出来，只留降级指针（源: 备忘录135）

## 当前状态

**已实现。** `syncRuntimeWorkspaceGuidance()` 在 Gateway 启动时运行，角色差异化注入生效。

**已知留口**：`COLLABORATION-FALLBACK.md` 既不在 `MANAGED_GUIDANCE_FILE_NAMES` 也不在 `EXECUTION_LAYER_CLEANUP` 里 → 不受漂移检测管辖。后果有两面：① agent 角色改成 executor 后旧文件永久滞留，让"标记教程与工具并排出现"这件刻意避免的事复现；② 执行层四角色**从一开始就没有**这份文件，所以任何指向它的指针对这四个角色都是死链。
