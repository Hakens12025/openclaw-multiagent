# openclaw-multi-agent-system — 结构化/系统CLI化 重构 spec

> 日期 2026-05-30 · 分支 `restructure/openclaw-multi-agent-system` · 起点 v108-stable(1186 pass/0 fail)
> 目标:把当前系统整成**干净、可发布的 openclaw 插件**,功能不变、可扩展,opencode 级的边界/接口/质量纪律。

## 1. 北极星(已校正的架构模型 —— 来自备忘录 61/79/110-114)
四者**不是顶层代码域**,是现有 runtime 身体之上的**控制/演化关节**(当前半成品,系统终态):
- **Harness = 工具**:拼图化/可复用执行塑形件(guard/collector/gate/normalizer),只发 `HarnessRun`/证据。红线:不碰协作/delivery/loop/治理真值。
- **CLI system = 手**:**系统正式可操作表面层**(hook/observe/inspect/apply/verify)= 驾驶舱/仪表盘/检修口/合规操作面。**系统CLI化** = 把散落在 hooks/timeline/snapshot/admin-surface/routes-api 的可操作表面**收口成同一层**。
- **Operator = 脑**:治理消费(读 formal truth+surface → inspect/apply/verify)。红线:**不准绕过 CLI-system 直写真值**,不当第二 planner。
- **Automation = 最终目标**:脑-手-工具闭环成熟后自然长出的自治能力。不退化成定时器/日志爬虫。
- 对象链:`HarnessRun → EvaluationResult → AutomationDecision → ProfileLifecycle`(尾段 ProfileLifecycle **本轮不建**,留干净扩展点)。

## 2. 纪律(不可违)
- **概念预算(114)**:这条线只许 11 个核心概念;**冻结接口,不冻结大词**;没 schema/读写点/测试的词不算正式对象;不造第二真值;不让任一层越界 owner。
- **为 agent 减负(113)**:拼图化 harness;本地 9B LLM 也能驱动。
- **功能不变**:串行回归门 `node --test --experimental-test-module-mocks --test-concurrency=1 --test-timeout=30000 tests/*.test.js` 全程 ≤ 基线(1186/0),收尾跑集成 preset。
- **一条路径/不留遗留/不硬编码 agentId**(沿用项目红线)。
- 不大爆炸搬迁;增量、分阶段、可回退;每部分对照 合规/效率/错误/冗余。

## 3. 决定(用户已拍)
- 插件名:`openclaw-multi-agent-system`。
- P-D 系统CLI化:**深度路由重构**——所有可操作表面强制走 CLI-system,operator 无旁路。

## 4. 阶段(多 agent,每阶段后跑门 + commit)
- **P-A 清理+打包**:删 cruft(backup/agent们_副本/.codex-live-backup/openclaw_use_guide 重复);gitignore 运行态(research-lab/test-reports/control-plane/workspaces/logs/output…);插件加 `package.json`+`README`+`openclaw.plugin.json`,边界清晰可 drop-in。
- **P-B 系统理解 skill**:从备忘录编译,教 脑-手-工具→自治链 + 概念预算 + 减负理想 + 真值/红线;零上下文(含小模型)可上手。
- **P-C 系统协调 agent**:专职守四关节配合(harness↔CLI↔operator↔automation),理解备忘录,牵一发动全身的协调与校验。
- **P-D 系统CLI化深度收口**(核心,分小步,每步测试守护):
  1. 冻结 `CLISurface` registry schema + `HarnessModule` 接口合同。
  2. 把散落表面(hooks/timeline/snapshot/admin-surface/routes-api)逐个收进 CLI-system,统一注册/调用。
  3. operator 改为**只经 CLI-system** 读/治理,移除直读散落 runtime state 的旁路。
  4. 守概念预算,不新增概念;给关键路径补测试锁定。
- **P-E 端到端样例**:`Harness → CLI system → Operator → Automation` 一条真实链路样例(114-§6 第3步),作为链路验收。
- **P-F 验收+push**:串行门全绿 + 集成 preset(qq-single/concurrent/loop-platform)+ 重启网关确认跑通 + 更新 wiki/备忘录 + `git tag v109-stable` push。

## 5. 风险与回退
- P-D 动"手"(surface 层),最牵一发动全身 → 分小步,每步隔离测试,转红即回退该步。
- 重启网关用 launchctl bootstrap(不是 `gateway start`);串行跑测试,别污染 live control-plane。
- 任何"非建新原语不可"的收口 → 停下报告(不偷建 ProfileLifecycle 等)。
