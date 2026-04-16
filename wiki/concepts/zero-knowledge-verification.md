# Zero-Knowledge Verification

> 在 hook 观测约束下实现可验证执行：不侵入 agent，只通过外部观测证明执行合规。

## 是什么

Agent 执行过程（30-120 秒）对外部是黑盒。框架 hook 系统可以观测（observe）但不能注入（inject）或修改（modify）agent 行为。在这个约束下，借鉴零知识证明概念设计的三种验证机制。

### 框架约束

| Hook | 能力 | 限制 |
|------|------|------|
| `before_tool_call` | 可以 block/allow | 不能注入内容 |
| `after_tool_call` | 可以观测结果 | 返回值为 void，不能修改 |
| Plugin 整体 | 可以收集证据 | 不能从 plugin 注入 agent 上下文 |

### 三种验证机制

#### 1. Execution Trace（执行轨迹）

在 `after_tool_call` 中构建工具调用的哈希链。

- 每个 session 维护独立 trace
- 每步记录：tool name, arguments hash, result hash, timestamp
- 使用 sha256 链式哈希：每步的 hash 包含前一步的 hash
- 篡改任意一步会导致后续所有 hash 失效

实现：`execution-trace-store.js`
- `initTrace(sessionId)` — 初始化 session trace
- `recordStep(sessionId, toolCall)` — 记录一步
- `getTrace(sessionId)` — 获取完整 trace
- `evaluateTrace(sessionId, contract)` — 对照合约评估 trace

#### 2. Commitment Detection（承诺检测）

对比 contract 期望的工具调用模式与实际调用。

- Contract 声明："完成此任务预期会调用 X, Y, Z 工具"
- 运行时对比实际 trace 与预期模式
- 检测 off-track agent：执行偏离承诺的 agent
- 不要求精确匹配，检测的是显著偏离

#### 3. Delegation Receipt（委托收据）

Watchdog 为 `system_action` 委托写入收据。

- 当 agent 请求系统级操作时，watchdog 生成收据
- 收据记录：谁请求、什么操作、是否批准、批准理由
- 提供事后审计链

### 对 Harness 的影响

零知识验证的证据模型直接影响了 [harness](harness.md) 的 trace_capture 模块和 artifact_collector 设计。Harness 的"可回放执行记录"概念继承自这里的执行轨迹。

## 为什么存在

- Agent 执行不可信（LLM 输出不确定性）
- 框架限制了干预手段（只能观测，不能注入）
- 需要在不侵入 agent 的前提下建立信任
- 为评估链提供可验证的执行证据

## 和谁交互

- **被消费**: [harness](harness.md) 的 trace_capture 和 artifact_collector 模块
- **约束定义**: [hard-soft-path](hard-soft-path.md) 区分代码保证段 vs LLM 处理段
- **防御体系**: [defense-in-depth](defense-in-depth.md) 的一个层次

## 演化

| 阶段 | 事件 |
|------|------|
| 零知识备忘录 | 提出三种验证机制，定义框架约束 |
| Harness 设计 | 证据模型被 harness 吸收为模块能力 |

## 当前状态

- **Execution Trace**: 已实现（execution-trace-store.js）
- **Commitment Detection**: 概念部分通过 harness 实现
- **Delegation Receipt**: 概念部分通过 harness 实现
- **来源**: ~/Desktop/零知识备忘录.md

相关概念: [harness](harness.md) | [hard-soft-path](hard-soft-path.md) | [defense-in-depth](defense-in-depth.md)
