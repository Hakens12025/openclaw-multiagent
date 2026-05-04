---
name: agent-bootstrap-designer
description: Agent 启动画像设计技能。用于创建新 agent、选择 role、规划 skills，并理解 OpenClaw bootstrap 生成的本地引导文件。
---

# Agent Bootstrap 设计

OpenClaw 为新 agent 注入最小平台画像。设计时先确定 role，再补必要 skills。

## agents.create 会生成什么

1. 在配置里注册 agent
2. 创建 workspace
3. 生成 `SOUL.md`
4. 生成 `HEARTBEAT.md`
5. 生成 `AGENTS.md`
6. 生成 `PLATFORM-GUIDE.md`
7. 生成 `agent-card.json`
8. 创建 `inbox/`、`outbox/`、`output/`
9. 写入默认 skills 和 role 基础画像

## role 语义

- `bridge`：前台和桥接节点，负责收消息、回消息、把请求送入楼内。
- `planner`：规划节点，负责拆任务、定阶段、组织执行。
- `executor`：执行节点，负责读 contract、产出结果、按契约交付。
- `researcher`：研究节点，负责检索、材料、方向和假设。
- `evaluator`：审查节点，负责质量判断、审查结果和治理裁决。
- `agent`：通用节点，适合尚未形成专门 role 的能力位。

## skills 来源

### 全局默认 skills

来自 `agents.defaults.skills`。

### 平台注入 skills

- 所有 agent 有效拥有 `platform-map`
- `agent` / `executor` / `researcher` / `evaluator` 有效拥有 `system-action`

### 单 agent 配置 skills

来自该 agent 的 `skills`。

### effectiveSkills

最终能力是全局默认、平台注入和单 agent 配置的合并结果。

## 生成文件职责

- `SOUL.md`：角色本地循环。
- `HEARTBEAT.md`：空闲唤醒行为。
- `AGENTS.md`：本地总引导。
- `PLATFORM-GUIDE.md`：平台入口、出口、协作方式和 skill 摘要。
- `agent-card.json`：对外画像，包含 role、tools、skills、formats、constraints。

## 设计顺序

1. 判定它是收发、规划、执行、研究、评估，还是通用节点。
2. 选择能表达职责的最小 role。
3. 添加完成当前职责所需的 skills。
4. 让平台引导文件承载入口、出口和协作说明。
5. 稳定复用的方法再沉淀成新 skill。

## 最小心法

1. role 是底座
2. skill 是增量能力
3. effectiveSkills 是实际能力
4. 平台引导文件提供入口和出口
5. runtime 提供协作与 delivery
