# Prompt 装配 (Prompt Assembly)

> Agent 系统提示词的六层装配模型；role / SOUL / wake 三者解耦，各有独立载体，按缓存稳定性排序。

## 是什么

一个 agent 看到的系统提示词由六层按序叠加，自底向上：

| 层 | 名称 | 载体 / 来源 | 谁拥有 |
|----|------|-------------|--------|
| ① | 框架层 (framework) | openclaw CLI 固定注入的 workspace 根文件集 | 框架 |
| ② | 工具层 (tools) | binding 的 `tools.allow/deny`，schema 由 runtime 提供 | 平台 |
| ③ | skill 头 (skill-heads) | system-usage skills，binding 驱动，渐进披露（注入 head，按需读全文）| 平台 |
| ④ | role 人格 (role) | `renderRolePersonaBlock(role)` → **IDENTITY.md**（托管，带 marker）| 平台 |
| ⑤ | SOUL（用户）| **SOUL.md**，无 marker，系统永不重写 | **用户** |
| ⑥ | wake（派工）| 合约机制 + `getRoleOutputDirectives(role)`，**仅系统派工路径有** | 平台 |

①「路径层」是对框架已知内容（根文件、工具 schema）的一个**代指**，不是一段实际正文。
真正的可见正文从 ④⑤⑥ 开始落到文件 / 手拼串里。

代码位置：
- ④role 渲染：`lib/prompt/role-spec-registry.js` `renderRolePersonaBlock` / `getRoleSoulProfile`
- ④落地为 IDENTITY.md：`lib/workspace-guidance-writer.js` `buildManagedIdentityDoc`（托管，`writeManagedFile` 覆盖）
- ⑤SOUL 用户占位：`lib/workspace-guidance-writer.js` `buildUserSoulPlaceholder`（`writeIfMissing`，不覆盖用户内容）
- ⑥wake 手拼：`lib/prompt/contract-session-prompt-override.js` `buildContractSessionSystemPrompt`

## 两条装配路径

由 **sessionKey** 判定，不是两套协议、是同一模型的两种投影：

**用户直连（main session）**
- 框架按固定槽位注入根文件（AGENTS/SOUL/TOOLS/IDENTITY/...）。
- 有 ④role（IDENTITY.md）+ ⑤SOUL，**没有 ⑥wake**——直连用户不需要"如何担任系统工作"。

**系统派工（contract session，`agent:<id>:contract:<cid>`）**
- watchdog 经 `before_prompt_build` 钩子**整体替换** systemPrompt（裁定1：框架只支持整体替换 / prependContext，无法 append 一段 system 区块，故"叠加"= watchdog 内字符串拼接）。
- 手拼顺序：**④role（前）→ ⑥wake 机制+产出指令 → ⑤SOUL（末尾）**。
- ⑥wake 是**叠加**，不替换 ⑤SOUL；用户写的 SOUL 原样追加在最末。

## 为什么这么排（缓存裁定）

裁定2：⑤SOUL 放**最末尾**。提示词缓存是 KV 前缀缓存（精确前缀匹配，写贵读省，5min TTL）。
SOUL 是用户高频编辑项；放尾巴让一次编辑只损坏前缀的尾部、而非整段。
排序原则 = **稳定 → 易变**：④role（稳定）→ ⑥wake（稳定）→ ⑤SOUL（易变，末尾）。
`contractId` / output path 等每合约 volatile 值**不内联进前缀**（否则每个新合约都 cache miss），
由 wake 消息 + `inbox/contract.json` 提供。

## 为什么存在

- **让用户只看到属于自己的 SOUL**：历史上把 role 人格烘焙进 SOUL，用户打开 SOUL 看到一堆系统注入的角色话术，分不清哪些是自己写的。解耦后 ⑤SOUL 是纯用户内容，④role 独立托管在 IDENTITY.md。
- **三者各自可独立演化**：换 role 不动 SOUL，改派工口径只动 ⑥wake，用户改人格只动 ⑤SOUL。
- **缓存友好**：稳定层在前、易变层在尾。

## 和谁交互

| 概念 | 关系 |
|------|------|
| [SOUL & Identity](soul-identity.md) | ⑤SOUL=纯用户身份；④role 现独立在 IDENTITY.md |
| [Wake Event](wake-event.md) | 两个"wake"不同：WakeEvent=**何时**唤醒（触发链）；⑥wake 层=**唤醒后**的派工正文区块 |
| [Workspace Guidance](workspace-guidance.md) | ④IDENTITY / ⑤SOUL 都是 workspace 文档，托管 vs 用户拥有 |
| [Token Economy](token-economy.md) | 六层排序服务于前缀缓存命中率 |
| [Skill Boundary](skill-boundary.md) | ③skill 头 = 方法层，与 ④role 身份层分离 |

## 演化

1. 早期：role 人格被烘焙进 SOUL.md（系统生成、带 marker）。
2. 本次重构：role→IDENTITY.md（④托管）、SOUL→纯用户（⑤）、wake→叠加且仅派工（⑥）；
   一次性迁移闸 `scripts/migrate-soul-identity.js` 把烘焙版 SOUL 拆成 IDENTITY+用户占位（已对 9 个 agent apply）。
3. 本次重构：④role 人格与 ⑤SOUL 占位、⑥wake 产出指令**全部改为英文**（见决策页）。

## 当前状态

**已落地、单测全绿。** 六层模型在两条路径上一致。
live-complex 全派发实测仍待 agent-graph 重建后补验（运行态阻塞，非提示词代码问题）。
