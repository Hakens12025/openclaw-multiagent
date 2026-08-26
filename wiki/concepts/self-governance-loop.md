# 四关节自治闭环（Self-Governance Loop）

> 脑-手-工具-自治四关节闭合成一条带反馈的真值回路，"用得越多越顺"的系统级自适应自治。

> **修订 v226（2026-08-23）**：四关节中的 harness（工具/塑形）关节已全退役
> （见 `use guide/备忘录149` / `备忘录150`），闭环收缩为 CLI-system/operator/automation
> 三关节。本页保留作历史设计记录。
## 愿景

OpenClaw 长成「会自己运维的系统内自治结构」，而非「更好用的 agent 工具链」。四关节——**harness=工具 / CLI-system=手脚 / operator=大脑 / automation=最终实现**——每跑一轮就把「怎么塑形 / 评得如何 / 怎么决策 / 能力是否值得固化」沉淀成正式对象：下一轮 operator 优先选现成拼图、harness 复用已验证模块、小模型只填内容不背流程。不靠外部超级大模型或人工外科手术。

## 三处真死链 — v115 全部闭合

纠正直觉误判：断点**不是**"action 无 dispatch"（action 已是 status/nextWakeAt 的派生投影）。物理实现 = 接通这三处，**不是**给已工作的控制路径加第二开关。v115（接 v112）三处全修：

| 死链 | 原现状 | v115 修复（代码核实） |
|------|--------|----------------------|
| (a) reworkGuidance 零消费 | 只构造、全仓 0 处读 | ✅ P1：落 runtime → 注入下轮 `entry.message`。现 8 处消费（automation-runtime/start/finalize + mailbox） |
| (b) CLI-system 无法真执行 | 误判"手全瘫" | ✅ P2.5 裁定 **admin-surface = 唯一 apply 真值源**（apply 链路本就活，28/44 可执行）+ P3 verify 经 cli-surface-registry 暴露 + admin-change-set commit 强制 verify 门（复用既有 verification 字段，不造第二套，`admin-change-set-commit-gate.js`） |
| (c) governanceSnapshot 无读取合流点 | 写了没人读 | ✅ P4：`resolve-governance.js` 合流点（snapshot 覆盖 spec）+ `profile-lifecycle.js` 现算 streak 渐进硬化 trustLevel → 写 governanceSnapshot 回灌下一轮 |

## 自治反馈回路（v115 已实接）

①harness 一次执行 → HarnessRun（唯一 run 级事实源）→ ②evaluator `buildEvaluationResult` → EvaluationResult（+confidence/findings）→ ③automation `deriveDecision` → AutomationDecision（reworkGuidance 注入下轮【修a】）→ ④经 admin-surface apply + commit 强制 verify 门【修b】→ ⑤`profile-lifecycle.js` 消费多轮历史 → 现算 streak 渐进硬化 trustLevel → 写 governanceSnapshot → `resolveGovernance` 合流点回灌下轮 harness【修c】。

**闭环判据（E2E，已断言）**：provisional automation 连跑 3 轮全 pass → trustLevel 升 **stable** → 下轮 `resolveGovernance` 读到收紧的 governanceSnapshot（比 spec 更紧）。测试 `tests/automation-profile-lifecycle-closed-loop-p4.test.js`。

**安全阀**（红线"安全阀非可选"）：全局熔断 `governanceSnapshotDisabled` → resolveGovernance 忽略 snapshot 回 spec 默认；retired profile 经 operator apply surface 复活（清 lifecycle + snapshot，streak 重置）。

ProfileLifecycle 是对象链尾段，**第 11 概念**，v115 已建（`lib/automation/profile-lifecycle.js`），**未新增第 12 概念**；只写 runtime snapshot 不改 spec，streak 派生不存 durable。详见 [evaluation-result-chain](evaluation-result-chain.md)。

## 阶段计划（依赖有序、增量、可回退）

P-1 现状基线普查（事实地基，无普查不动代码）→ P0 HarnessModule 接口归一 → P1 接通 reworkGuidance → P2 EvaluationResult 历史+confidence/findings → P2.5 裁定 apply 唯一路径 + cli-system 真执行 → P3 verify 族 → P4 ProfileLifecycle + resolveGovernance 合流点 → P5 operator 还原为真 meta-agent + 经 CLI-system 闭环（配好接口/知识/落地通道；复用 EvaluationResult+source=operator）→ P6a God-role 清理 → P6b Agent-Group 空间原语（与回路无数据依赖，可并行）→ P7 收尾。

**建议起点**：P-1 + P0 + P1（让"上轮教训进下一轮"先跑，低风险、不碰写路径）。

## 11 条红线纪律

概念预算 ≤11（否决第 12 概念）·一条路径（apply 裁定 cli-surface vs admin-surface 唯一）·不造第二真值（verify 回写既有字段，ProfileLifecycle 只写 snapshot 不改 spec）·写了必被读（新字段必有唯一读取合流点 + 回归门）·代码管流程/LLM 管内容·**operator 是真 meta-agent 非 if-else 引擎**（它该理解/判断/规划；约束在落地纪律=经 cli-system apply/verify 落地、可审计回滚、brain 不可用时如实说明，非剥夺智能）·automation 不退化定时器·先普查后定义·传送带纪律（graph=授权非时序）·安全阀非可选（全局熔断 + retired 复活）·scope/质量（surgical + 失效清单 + UTF-8 无 BOM）。

## 和谁交互

- [evaluation-result-chain](evaluation-result-chain.md)：四对象链是这条回路的信息骨架。
- [harness](harness.md) / [CLI System](cli-system.md) / [operator](operator.md) / [automation-of-automation](automation-of-automation.md)：四关节本体。
- [传送带原则](conveyor-belt.md)：P6 清 god-role、Agent-Group 复用 graph 授权的纪律来源。

## 当前状态

**v115：自治回路物理闭合**——三死链全修，端到端闭环判据已断言。harness 灵魂落地（见 [Harness](harness.md) Run-Shape Map / 反逼 / Meta-harness 闸）。余 P5（operator 经 CLI-system 闭环）/ P6（God-role 清理、Agent-Group）按计划推进。源: `docs/PLAN-four-joint-self-governance-2026-05-31.md` + 各阶段 commit。
