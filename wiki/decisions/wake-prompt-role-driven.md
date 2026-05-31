# wake 提示词数据驱动接入 role-spec

> 系统派工(wake)提示词从 role-spec 派生 per-role 个性,消除「6 role 实际只有 2 种 wake 提示词」的真值分裂。

**状态:已实施(ACCEPTED,2026-05-31)** — 用户批准方案 A,并定下:wake 全英文 + SOUL 也英文 + (b) 保留 bullet 结构。已落地并通过完整串行门(1544/0),已编译 [SOUL & Identity](../concepts/soul-identity.md) 概念页。

## 决策

采用**方案 A**:让 `buildContractSessionSystemPrompt`(wake 时替换 SOUL 的系统提示词)从 `role-spec-registry` 数据驱动派生 per-role 个性段,并用 `outputDirectives` 数据字段替代当前的 `if (role === PLANNER)` 特化分支。

一次拿下三件事:
1. **激活 role 设计**:6 个 role(bridge/planner/executor/researcher/reviewer/agent)在 wake 时各自体现 persona / qualityBar / operatingPrinciples,而非"planner 一种、其余 5 个共用一种"。
2. **消除特化分支**:`buildOutputDirectives` 里的 `if (role === PLANNER)` 硬分支 → 数据驱动读 role-spec 的 `outputDirectives`。
3. **死字段清理**:`dispatchInstruction`/`getDispatchInstruction` 退役删除(被结构化 `outputDirectives` 取代)。

## 问题背景(真值分裂)

调研确认,改前存在两套提示词,且 wake 路径几乎不用 role 设计:

- **两套提示词,载体不同**
  - SOUL.md(`lib/soul-template-builder.js`,6 个 per-role 模板)→ 写进 agent workspace,**仅用户直连时生效**。
  - contract-session-override(`lib/contract-session-prompt-override.js` 的 `buildContractSessionSystemPrompt`)→ 经 `hooks/before-prompt-build.js` 在 `before_prompt_build` **系统派工时替换 SOUL**(index.js 注册)。
  - 选择逻辑:`lib/agent/agent-session-system-prompt.js`(`isDispatch ? agentAwake : soul`)。
- **wake 时 6 role 只有 2 种提示词**:`buildOutputDirectives(role)` 只判断 `role === PLANNER`,其余 5 个 role 在 wake 时拿到**逐字相同**的提示词。
- **per-role 个性活在 SOUL,但 SOUL 在 wake 时被替换**:`role-spec` 的丰富设计经 `getRoleSoulProfile` 只喂给 SOUL 模板,系统派工时整体失效。
- **`dispatchInstruction` 是死字段**:`getDispatchInstruction` 只被 4 个测试消费,`lib/` 生产零消费,framework core 也不读。测试常绿,给了"它在工作"的假象。

违反核心红线:「真值唯一」(role 个性源分裂)、「不留死代码」(`dispatchInstruction`)、「数据驱动优于 if-else」(`if role===PLANNER`)。

## 替代方案

- **B. SOUL 与 override 合一(单一组装器)**:更彻底,但 SOUL.md 是写进 workspace 的文件、override 是内联替换,载体不同,合一需先统一载体——单独一场手术,列为 A 之后可选第二步,不一锅端。
- **C. 只清死字段 + 文档化现状**:放弃全部 per-role wake 设计,真值分裂只被"承认"而非消除。否决。

## 收法决策(已定:(b) + 全英文)

用户选 (b) 收法 + 全英文。最终实现:
- `dispatchInstruction` 长句退役,拆成结构化 `outputDirectives`(per-role 英文 bullet 数组),wake 数据驱动读它 → 既消除 `if(role===PLANNER)`,又保留 bullet 风格。
- 死字段 `dispatchInstruction`/`getDispatchInstruction` 删除(被 `outputDirectives` 取代,留着即新死字段)。
- 「读 upstreamPackages」是通用输入协议,收进 wake 骨架(所有 role 共用),不放 per-role `outputDirectives`。
- role-spec 与 SOUL 模板**全英文化**(用户定 SOUL 也英文 → 真值唯一一套英文源,wake 与 SOUL 风格一致)。

## 改后数据流(真值收口到 role-spec)

```
role-spec-registry  (唯一英文源)
  ├─ getRoleSoulProfile / renderRolePersonaLines ─┬→ SOUL 模板 (soul-template-builder, 用户直连)
  │                                               └→ wake 「## Role」段 (contract-override, 系统派工)
  └─ getRoleOutputDirectives → wake 「## Current Contract」产出 bullet (替代 if(PLANNER))
```

## 实施结果(2026-05-31)

- `lib/role-spec-registry.js`:6 role 全英文 + 新增 `outputDirectives` + `renderRolePersonaLines`(共享渲染)+ 删 `getDispatchInstruction`/`dispatchInstruction`/`joinDispatchInstruction`。
- `lib/soul-template-builder.js`:6 个 SOUL 模板全英文化(只改语言,结构不动)+ 复用 `renderRolePersonaLines`。
- `lib/contract-session-prompt-override.js`:`buildContractSessionSystemPrompt` 注入 `## Role`(summary + persona 行)+ `getRoleOutputDirectives` 替代 `buildOutputDirectives`(已删)+ `upstreamPackages` 读取入骨架。
- 测试:7 个测试的中文断言改英文等价 + 2 个 mock 测试删无效遗留 `getDispatchInstruction` mock。
- 验证:完整串行门 **1544/0**。wake 每 role 性格分化(executor=工程师 / reviewer=审查者 / planner=规划者);planner 产简报 + `[STAGE]`,其余产交付物。
- **范围注记(范围 1)**:只注入人格/质量/准则。executor 与 reviewer 的产出 bullet 仍相同(都 "Write the user-facing deliverable artifact"),差异在 `## Role` 段。reviewer 的 `[BLOCKING]` 输出格式块仍只在 SOUL(用户直连),未进 wake——若要进 wake 需把格式块迁进 role-spec(范围 2,未做)。

## 影响

- **概念页**:[SOUL & Identity](../concepts/soul-identity.md) 已补「系统派工时 SOUL 被 contract-override 替换,且该提示词同样从 role-spec 派生 per-role 个性;两套提示词全英文同源」。关联 [wake-event](../concepts/wake-event.md)、[workspace-guidance](../concepts/workspace-guidance.md)、[three-layer-protocol](../concepts/three-layer-protocol.md)、[god-role-elimination](god-role-elimination.md)(强化 role=数据驱动 policy)。
- **token**:wake 提示词每 role 增 `## Role` 段(executor ≈ +8 行 / reviewer ≈ +6 行英文),增量可控但每轮每 agent 生效。

## 出处

讨论日期: 2026-05-31。调研代码真值:`lib/contract-session-prompt-override.js`、`lib/role-spec-registry.js`、`lib/soul-template-builder.js`、`lib/agent/agent-session-system-prompt.js`、`hooks/before-prompt-build.js`;消费链 grep 确认 `getDispatchInstruction` 改前生产零消费。
