---
name: agent-bootstrap-designer
description: Agent 启动画像设计技能。用于创建新 agent、选择 role、规划 skills，并理解 OpenClaw bootstrap 会生成哪些本地引导文件。
---

# Agent Bootstrap 设计

你在设计一个带平台基座的 agent。

OpenClaw 会为新 agent 注入一套最小平台画像。你的工作是：

- 选对 role
- 只加必要 skills
- 让 agent 一开始就知道平台入口和出口

## 创建一个 agent 时会发生什么

`agents.create` 目前会做这些事：

1. 在配置里注册 agent
2. 创建 workspace
3. 生成这些文件和目录：
   - `SOUL.md`
   - `HEARTBEAT.md`
   - `AGENTS.md`
   - `PLATFORM-GUIDE.md`
   - `agent-card.json`
   - `inbox/`
   - `outbox/`
   - `output/`
4. 给 agent 写入默认 skills 和 role 对应的基础画像

## 先选 role，再谈技能

当前 role 是平台画像基座。

### `bridge`

- 负责收消息、回消息
- 按平台图和入口派发执行链
- 默认并发比其他角色高

### `planner`

- 负责拆任务、定阶段
- 通过契约和图交给执行节点

### `executor`

- 负责读 contract、产出结果、按契约交付

### `researcher`

- 负责研究、检索、找方向
- 默认工具里带 `web_search` / `web_fetch`

### `evaluator`

- 负责审查、评价、给 verdict
- 覆盖代码与产物审查

### `agent`

- 通用平台节点
- 当专门角色尚未确定时，用它比乱造新 role 更稳

## 默认 skills 和 effective skills

要分清三层：

### 1. 全局配置默认 skills

来自 `agents.defaults.skills`。

### 2. 平台强制 / 角色注入 skills

当前固定规则：

- 所有 agent 都会有效拥有 `platform-map`
- `agent` / `executor` / `researcher` / `evaluator` 会额外有效拥有 `system-action`

注意：

- `platform-map` 与 `system-action` 属于平台保留注入逻辑
- 通过 role 和 runtime 配置决定它们的生效范围

### 3. 单个 agent 自己配置的 skills

来自该 agent 的 `skills`

### `effectiveSkills`

最终生效的是三者合并后的结果：

- 全局默认
- 平台注入
- agent 自己配置

所以“配置了什么”和“最后实际拥有了什么”是两层事实。

## Bootstrap 生成的文件各自做什么

### `SOUL.md`

主循环和绝对规则。告诉 agent 先读 contract，再执行，再停机。

### `HEARTBEAT.md`

空闲时的最小行为提示。

### `AGENTS.md`

面向 agent 的本地总引导。告诉它自己处在平台运行环境中。

### `PLATFORM-GUIDE.md`

平台入口、出口、协作方式、已加载 skill 摘要。

### `agent-card.json`

对外画像。里面有：

- `role`
- `capabilities.tools`
- `capabilities.skills`
- `inputFormats`
- `outputFormats`
- `constraints`

## role 会影响什么

role 会决定 bootstrap 基础画像：

- 默认工具集
- 默认输出格式
- 默认描述
- 默认约束
- 是否自动获得 `system-action`

所以如果你的目标只是“想让这个 agent 更懂平台”，通常先改 role，再决定是否补 skill。

## 改 role / skills 之后会发生什么

当前 watchdog 会在同步画像时刷新：

- `agent-card.json` 的基础画像
- `AGENTS.md`
- `PLATFORM-GUIDE.md`

注意边界：

- 这只会刷新 watchdog 管理的引导文件
- 用户手改且移除了 managed 标记的 `AGENTS.md` 保持手工版本

## 设计一个新 agent 的顺序

1. 先问它是收发、规划、执行、研究、评估，还是通用节点
2. 选最小 role，先保持技能最小集
3. 只给它完成当前职责必需的 skill
4. 让它通过 `PLATFORM-GUIDE.md` 和 skill 获取协议
5. 真有稳定复用需求，再增加新的 skill

## 最小心法

1. role 是底座，skill 是增量
2. effective skills 才是 agent 真正拥有的能力
3. `platform-map` 保证 agent 通过平台入口获取协议
4. `system-action` 只给需要协作动作的角色
5. 新 agent 先会用平台，再谈复杂自主性
