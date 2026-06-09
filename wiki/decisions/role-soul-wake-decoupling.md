# role / SOUL / wake 三者解耦 + 提示词英文化

> SOUL 只是 SOUL（纯用户人格）；role 角色段与 wake 派工段拆成独立注入层，不再烘焙进 SOUL；三层提示词全部改为英文。

## 决策

把原先混在 SOUL.md 里的内容拆成[六层装配](../concepts/prompt-assembly.md)的三个独立层：

- **④role** → 托管 `IDENTITY.md`（`renderRolePersonaBlock`，带 marker，随 role 重生成）。
- **⑤SOUL** → 纯用户人格（`SOUL.md`，无 marker，系统永不重写，`writeIfMissing` 只种英文占位）。
- **⑥wake** → 合约机制 + `getRoleOutputDirectives(role)`，仅系统派工路径手拼，**叠加**在 SOUL 之上、不替换它。

三层（④role 人格 / ⑤SOUL 占位 / ⑥wake 产出指令）的正文**全部改为英文**。

## 原因

- **用户分不清自己的内容**：role 人格烘焙进 SOUL 后，用户打开 SOUL 看到一堆系统注入的角色话术，以为那是自己的，实则被混入了平台内容。解耦后用户看 SOUL = 纯自己写的。
- **三者独立演化**：换 role 不动 SOUL；改派工口径只动 ⑥wake；用户改人格只动 ⑤SOUL。耦合在一起时改任何一处都要碰 SOUL。
- **wake 不该替换 SOUL**：派工是"如何担任系统工作"的附加说明，是叠加语义；直连用户场景根本没有 wake。
- **缓存友好排序**：装配顺序稳定→易变（④role → ⑥wake → ⑤SOUL 末尾），用户高频编辑的 SOUL 放尾巴，一次编辑只损坏前缀尾部。
- **英文化**：提示词统一英文，口径一致、利于模型行为稳定。

## 否决的替代方案

- **role 烘焙进 SOUL（原方案）** —— 已否决。用户身份层被系统内容污染，且三者无法独立演化。已写一次性迁移闸 `scripts/migrate-soul-identity.js` 把烘焙版拆开，并删除旧的 `lib/soul-template-builder.js`（role-baked SOUL 生成器）。
- **靠框架 append 一段 system 区块实现"叠加 wake"** —— 不可行。框架 `before_prompt_build` 只支持整体替换 systemPrompt 或 prependContext（进 user message），无法 append system 区块。故"叠加"在 watchdog 内用字符串拼接实现（`buildContractSessionSystemPrompt`）。
- **把 contractId / output path 内联进提示词前缀** —— 否决。每个新合约都会 cache miss；这些 volatile 值改由 wake 消息 + `inbox/contract.json` 提供。

## 影响

- **prompt-assembly**：六层模型确立，两条装配路径（用户直连 / 系统派工）由 sessionKey 判定。
- **soul-identity**：SOUL 定义从"角色描述+品质"改为"纯用户人格"；④role 移入 IDENTITY.md。
- **workspace-guidance**：IDENTITY.md 升级为托管人格载体（`writeManagedFile` 覆盖）；SOUL.md 为用户拥有（`writeIfMissing`）。
- **网页端**：dashboard prompt 面板改为六层投影展示（`agent-session-system-prompt.js` + `dashboard-workflow.*`）。
- 单测全绿；live-complex 全派发实测待 agent-graph 重建后补验。
