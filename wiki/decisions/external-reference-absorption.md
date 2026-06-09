# 外部参考吸收策略

> DeerFlow = 执行层参考，AutoGen Studio = 作者体验参考。两者都不替代 OpenClaw 的平台层。

## 决策

对外部框架采取"选择性吸收"策略，不做整体替换：
- **DeerFlow** 仅作为执行层参考（skills/tools/memory/sandbox）
- **AutoGen Studio** 仅作为作者体验参考（声明式配方、Builder/Playground 分离）

## 原因

**DeerFlow** 擅长执行但无法替代 OpenClaw 的平台目标：contract、loop、operator、schedule、automation、delivery、platform truth。

**AutoGen Studio** 的 team-centric 模型与 OpenClaw 的 graph-first truth 模型不匹配 — 前者以团队配置为核心，后者以拓扑图为核心。

## 从 AutoGen Studio 吸收

- 声明式 recipe（配方）
- Builder / Playground 分离
- Import / Export
- Gallery
- Run visualization

## 从 AutoGen Studio 不吸收

- Team config 作为平台真值（OpenClaw 用 graph）
- Session playground 作为系统主语义
- 当前阶段的 auth-first 设计

## 从 DeerFlow 吸收

- Sandbox / tool 边界
- Run isolation
- Trace / artifact / evidence
- Execution harness

## 从 oh-my-pi 吸收 (2026-06)

oh-my-pi（Pi 的单 agent 编码分叉，与 OpenClaw 是反向分叉）的去 cargo-cult 借鉴见 [oh-my-pi 借鉴](oh-my-pi-borrow-2026-06.md)：TIER-1 provider 兜底链已落地（v161）；最高杠杆教训 = 把"Harness Problem"对准自己（度量而非声明 harness 能力）。SKIP 环检测拒绝（与我们 loop 原语相反）等。

## 影响

- OpenClaw 保持自己的平台层设计，不被外部框架带偏。
- 执行层和体验层可以借鉴成熟方案，加速开发。

## 出处

备忘录64、81、82；oh-my-pi 见备忘录125（2026-06-09）
