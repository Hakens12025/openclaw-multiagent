# Planner

> 基座重新定位：从专用角色到 planMode 配置，任何 agent 都可以是 planner。

## 是什么

Planner 从一个专用 agent 角色，重新定位为一种可配置能力。通过 `planMode` 配置项，任何 agent 都可以具备计划能力。

### planMode 配置（备忘录 85）

| 值 | 行为 |
|----|------|
| `auto` | Agent 自行决定是否先做计划 |
| `off` | 禁用计划能力 |
| `required` | 必须先输出计划再执行 |

### Contractor = planMode 的一个实例

Contractor 不是结构角色，而是：
```
planMode: "required" + skills: ["system-action"]
```

即：强制计划 + 系统操作技能。任何 agent 配置为这个组合就等价于 contractor。

### DRAFT->PENDING 生命周期消除（备忘录 96）

旧流程：
```
ingress -> DRAFT -> (human review) -> PENDING -> execution
```

新流程：
```
ingress -> PENDING -> execution
```

DRAFT 状态被消除，ingress 直接创建 PENDING 状态的任务。

### plan-dispatch-service.js 自然失活

`plan-dispatch-service.js`（594 行）随着 DRAFT 消除而自然失活 — 它的存在理由（管理 DRAFT->PENDING 转换）不复存在。

### 三种标记解析器（Rule 12.2）

文件级协议被三种内联标记替代：

| 标记 | 用途 |
|------|------|
| `[ACTION]` | 标记执行动作 |
| `[STAGE]` | 标记阶段转换 |
| `[FINDING]` | 标记发现/结论 |

### 上下文拥塞问题（备忘录 97）

问题：~2000+ tokens 的上下文信息淹没 SOUL 指令，导致 planner 完全跳过计划编写。

根因：所有角色看到相同的膨胀上下文。

修复：`workspace-guidance-writer` 为不同角色写入差异化文件，planner 只获得最小必要上下文。

### Contractor 硬编码问题（备忘录 86）

Contractor 在 6 条链路中存在 **19+ 处硬编码引用**，是 [god-role-elimination](god-role-elimination.md) 的另一个清理目标。

## 为什么存在

- 计划能力不应被锁定在单一 agent 角色上
- DRAFT 状态增加了不必要的审批延迟
- 文件级协议比内联标记更重、更脆弱
- Contractor 的 19+ 硬编码引用使系统僵化

## 和谁交互

- **消除**: [god-role-elimination](god-role-elimination.md) 中 contractor 硬编码清理
- **绑定**: [agent-binding](agent-binding.md) 定义 planMode 如何绑定到 agent
- **合约**: [contract](contract.md) 定义计划输出的格式合约
- **交互协议**: [agent-system-minimal-interaction](agent-system-minimal-interaction.md) 限制 planner 与系统的交互面

## 演化

| 阶段 | 事件 |
|------|------|
| 备忘录 85 | planMode 配置化，contractor 降级为配置实例 |
| 备忘录 86 | 量化 contractor 硬编码（19+ 处，6 条链路） |
| 备忘录 96 | DRAFT 消除，plan-dispatch 失活 |
| 备忘录 97 | 上下文拥塞问题识别与修复方案 |

## 当前状态

- **DRAFT 消除**: 已实现
- **plan-dispatch 失活**: 已完成
- **God-role 清理**: 进行中
- **来源**: 备忘录 85, 86, 96, 97

相关概念: [god-role-elimination](god-role-elimination.md) | [agent-binding](agent-binding.md) | [contract](contract.md) | [agent-system-minimal-interaction](agent-system-minimal-interaction.md)
