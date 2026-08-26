# 平台服务 FC 族：submit_output 先行，plan/progress 成对缓建

> 平台服务 FC 是 agent **向平台交付**的工具族（区别于协作三件套的 agent **找人**）。三件里只有 `submit_output` 扛着平台不可知的职责，因此单独先建；`submit_plan` 与 `report_progress` 是同一功能的两半，一起缓建。

## 决策

**建**：`submit_output(status?, summary?, reason?)`

**缓建（成对）**：`submit_plan` + `report_progress`

**词表占位**：`PLATFORM_SERVICE_TOOLS` 表一次成型，三行都在场，缓建的两行 `exposedAsTool: false`。与 `collaboration-intent-policy` 里 `create_task` 的处理同款——在词表里可被识别为"已知但未开放"，而不是"未知"。

## 原因

### 为什么 submit_output 必须先建

它扛着**平台自己观察不到**的三件事：`status: failed` / `awaiting_input` / `hold`。

v181 刀1 取消了"不写 `outbox/runtime_result.json` 就不采集"的强制，但**没有取消这个文件的承重职责** —— 今天 agent 要表达失败，仍然只能靠知道一个私有约定的文件名。这直接顶着[平台/Agent 解耦](../concepts/platform-agent-decoupling.md)的判据：

> 没读过文档的新 agent 进来能干活吗？→ 能派活、能请审、能交产物，**但表达不了失败**。

### 为什么 plan 与 progress 是一件事

用户裁定（2026-08-09）：`submit_plan` 报 N 个 stage → agent 完成第 n 个就 `report_progress(n)` → **前端实时给 stage 打勾**。

计划与进度是同一个 UI 机制的声明面与推进面，分开建会出现"有计划无进度"的中间态：前端拿到 N 个 stage 却永远显示未完成。因此成对。

### 为什么 submit_output 不必等 plan

两者只共用**地基**（服务表 + `isExposedPlatformServiceTool` + `before_tool_call` 并集对称），而地基本来就是实施顺序的第 1 步。

不共用的部分：`submit_output` 不需要 `expectations.expectedSubmissions`、不需要 required 覆盖边界的裁定、不需要考官改动。它走与协作三件套**平行**的落地路径——直连本地 handler，不开票据、不查图边、不跨 agent。

## 替代方案

**三件同批建**：被 plan 缓建否决。plan 牵动 `expectations` 第三块与考官侧改动，而期望面今天只有 `assign_task` 一个写入点（`buildHopExpectations()` 恒 `return null`），要补齐就得动图 schema——那会给已经服务四个消费者的图边挂第五种语义，重演"一张图三种相反要求"那场自毁。

**只建 submit_output、词表不占位**：被"动两次表"否决。服务表要被 `before_tool_call` 的并集对称消费，每次动表都是一次回归面。

**report_progress 不占位**（本页作者的初始建议，已被用户推翻）：理由是"没有已知承重职责"。**错了**——它有明确机制（前端 stage 打勾），只是当时没问清它与 plan 的关系。教训：判一个未建符号该不该占位，要先问它属于哪个功能，而不是看它自己有没有需求。

## 影响

- `submit_plan` spec（`docs/superpowers/specs/2026-08-06-submit-plan-design.md`）整体缓建；其 §9 三点裁决**不再是解锁点**——先前把它当"依赖链上成本最低的解锁点"的判断随本决策作废
- §9-② `stages` 上限：机制已定（**硬拒不截断**，截断违反"平台知道答案却不说"）；数值待定，现有两条论据都指向低于 20——超限拒绝应当是"该拆合约了"的信号，且 N 个 stage = 前端 N 个勾
- **刀3 需换前置**：`resolvePreferredPrimaryArtifactFile` 原计划第①档读 `expectations.requiredArtifacts`，随 plan 缓建而更远。可退成两档式（唯一文件直接用 / 多文件不猜），今天即可做，且严格于现状的"猜第一个 `.md`"
- `buildHopExpectations()` 恒 `return null` 是**已裁定的边界**，不是待接线——须在代码里写明，否则每轮死码扫描都会把它报上来（2026-08-09 已误报一次）

## 出处

`源: 备忘录137` · 用户裁定 2026-08-09 · 前序设计 `docs/superpowers/specs/2026-08-06-submit-plan-design.md`
