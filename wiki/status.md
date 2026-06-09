# 项目状态

> 最后更新: 2026-06-02（~v132-stable）

## 当前位置

- **operator 手已通**：operator-executor 落地经 CLI apply（38 个 `operatorExecutable` surface）+ structure-snapshot 原子回滚 + forceVerify-after-apply。死链 (b) 闭合。废弃旧记「operatorExecutable=0 / 手仍瘫」。
- **operator 旗舰硬化（designer-only）**：operator 设计 loop 结构 active 即终态，跑由用户下游触发（不 emit `runtime.loop.start` 携带用户具体任务）。配套 planner 可靠性：single-retry / resilient-normalize（坏 step 丢单步保全盘）/ feasibility 预检 / GLM-socket 区分（abort/socket 失败不被 retry 掩盖）。进行中任务 #57 / #58。
- AgentGroup（v119 宏展开）、ProfileLifecycle（`lib/automation/profile-lifecycle.js`，streak→trustLevel→governanceSnapshot）、HarnessModule（`harness-module-catalog.js` 10 模块/4 kind 冻结）均**已落地**。
- **2026-05-30 全面修复完成（W0-W8）**：核心正确性/安全/真值/架构已修，卫生层 god-object 部分拆分（64→约 28 非测试 JS），详见备忘录119。
- 系统真值 v5.1 主线已落地：managed guidance、typed wake、pending-signal registry、execution epoch、controller/operator 边界、QQ `[ACTION]` 收口、bare max tool budget 退休。
- runtime graph 是协作拓扑真值；queue、claim、drain、heartbeat actionability 均由 runtime 状态决定。
- `prompt-craft` 已收口为 OpenClaw Prompt Standard：minimal useful prompt，协议真值留在 runtime 对象与正式 surface。
- CLI system / Harness / Operator / Automation 继续按四层联动看待：执行塑形、可操作表面、治理消费、长期演化。

## 当前活跃拓扑

controller + planner + worker + worker2/worker-N。operator 是隐藏 runtime control agent，入口在 runtime operator surface，不进入主 agent 视角。

## 当前最直接的架构债务

1. **god-object 剩余约 28 个**（前端 9 个 dashboard IIFE/闭包态；qqbot gateway.ts=1593 行；少数后端纠缠）— 需先补测试基础设施再拆。
2. **Path B（loop-session）完全引用化**、**OUTBOX_COMMIT_KINDS 单源化** — 格式变更/循环依赖，需独立任务。
3. **reviewPolicy schema、WakeEvent** — 骨架未落地，按 Q1 搁置。（AgentGroup 已于 v119 落地，移出此项。）
4. **automation trustLevel / profile-lifecycle 治理链** — 已落地（v115），闭环 E2E 已断言。
5. **agent-graph.json 补边**（worker-3/4/operator/reviewer 不可达）— 需独立任务。
6. **HarnessModule 与 CLISurface schema 仍需完全冻结** — 接口对象已经存在，schema / docs / guard 需要继续收口。

## 阻塞关系

```
prompt 标准未被 guard 化
  → agent-facing 文案容易重新承担 runtime truth

queue 并发证据不足
  → live simple/complex 稳定性难以区分系统故障与模型故障
```

## 方向已冻结、接口待实现的重要对象

| 对象 | 来源 | 状态 |
|------|------|------|
| WakeEvent / typed wake envelope | 备忘录84 / 118 | typed envelope 主线已落地，持续清理旧 string 语义 |
| ExecutionObservation + TerminalOutcome | 备忘录100 | 主干已部分落地，仍待消费面继续统一 |
| AutomationDecision + ProfileLifecycle | 备忘录80 | **已落地**（v115，`profile-lifecycle.js` + `inspect.profile_lifecycle`，闭环 E2E 已断言） |
| reviewPolicy schema | 备忘录88 | 概念设计完成 |
| AgentGroup 图原语 | 备忘录85 | **已落地**（v119 宏展开，`agent-group-spec.js` + `inspect.agent_groups`） |
| HarnessModule formal interface | 备忘录115 | **已冻结**（`harness-module-catalog.js` 10 模块/4 kind，`validateHarnessModuleDefinition`） |
| OpenClaw Prompt Standard | 2026-05-04 清洁批次 | 已落到 `skills/prompt-craft/SKILL.md`，guard 已接入 |

## 下一步建议

1. 完成 prompt / operator / admin / dashboard / wiki 用户可见旧语义清洁。
2. 用 guard 固定 OpenClaw Prompt Standard 与 runtime graph wording。
3. 继续跑 simple/complex 并发，按 runtime evidence 区分模型慢、LLM 输出错、queue 故障。
4. 冻结 `HarnessModule` 与 `CLISurface` schema 后，再推进 `Harness -> CLI system -> Operator -> Automation` 样例。
