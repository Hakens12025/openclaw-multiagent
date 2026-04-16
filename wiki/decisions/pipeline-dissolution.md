# Pipeline 解体

> 删除 pipeline-engine.js（875行）及 7 个子模块（共 1717 行）。loop-session 吸收决策逻辑，dispatch graph policy 保持纯投递。

## 决策

删除整个 pipeline 引擎。其 6 项职责已被现有模块完全覆盖：
- **dispatch graph policy** — 纯消息投递
- **loop-session** — 决策逻辑、会话状态
- **harness** — 执行编排

Pipeline 曾是系统最初的编排中心，但统一协议建立后已完全冗余。

## 原因

- Pipeline 的 875 行主文件 + 7 个子模块共 1717 行，职责已被其他模块吸收。
- 保留 pipeline 意味着两套并行的编排语义共存，开发者需要同时理解两条路径。
- 统一协议（ingress → conveyor → delivery）建立后，pipeline 成为死代码的温床。

## 否决的替代方案

1. **保留 pipeline 与 loop-session 并行** — 两套编排系统共存是持续的认知负担和 bug 来源。
2. **备忘录90的方案："新建 3 个文件替换"** — 方向错误。备忘录91 纠正：重构的净新增代码应为负数。

## 影响

- 编排路径从两条收敛为一条（loop-session）。
- dispatch graph policy 职责明确为纯投递，不做决策。
- 代码量净减少约 1700 行。

**当前状态**：半完成（备忘录98）。旧引擎仍在 loop-session-store facade 背后运行。

## 出处

备忘录92
