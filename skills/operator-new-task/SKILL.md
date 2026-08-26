---
name: operator-new-task
description: operator 面对一个全新项目/任务时的正确处理流程：读→析→拆→建结构→特色化→预览。教 operator 用真实 CLI-system surface 搭出能处理该项目的 agent 结构与 agent 内容（角色/技能/工具）。operator 只设计结构与 agent 内容，到预览为止；具体任务由用户/ingress 下游投入运行，operator 不注入也不运行任务。
---

# 新任务处理流程（operator 专用）

用户丢来一个新项目时，**不要急着建 agent**。按这 6 步设计——operator 只设计结构与 agent 内容，每步用真实 CLI-system surface。

## 1. 阅读项目
- 先搞清楚项目是什么：输入数据（格式/规模/字段）、目标产物、约束。
- 项目数据通过**任务 contract / inbox** 送到 agent（agent 是 workspace 沙箱，只读自己的 `inbox/`，不漫游文件系统）。所以"让 agent 读 data" = 把数据随任务投递进入口 agent 的 inbox，而非让 agent 去读桌面绝对路径。

## 2. 分析项目
- 需要哪些角色？（如：研究/搜罗信息、执行/产出交付物、审查/把关质量）
- 是单次线性流，还是要反复迭代（GAN 式判别环），还是并行汇总？
- 领域知识缺口在哪？（这些要变成 skill，见第 5 步）

## 3. 步骤分解
- 拆成可验证的阶段，每阶段一个清晰交付物 + 完成标准。
- 这决定了结构形态（线性 / 成环 / 并行组）。

## 4. 建立角色与结构（真实 surface）
- 建 agent：`agents.create`（id + role + model）。
- 连结构（图边=固定管线）：
  - 线性管线：`graph.edge.add`（a→b→c 逐跳）。
  - 迭代结构：同样用 `graph.edge.add`，把末跳连回入口（a→b→c→a）。环就是边闭合出来的形状，平台自己识别并高亮，没有独立的 loop 对象要注册。
  - 并行聚合组：`graph.group.compose`（members + outputMode）。

## 5. 特色化 agent（关键——经 skill 注入，**不改 SOUL 文本**）
平台铁律：**SOUL 只写通用行为，领域知识全部通过 skill 注入**。所以特色化 = 装 skill + 设角色/工具，不是编辑 SOUL/wake 文本（那会硬编码领域、违反"通用机"原则，且没有这种 surface）。
- 领域知识 → 先 `skills.create`（authorSkill）建领域 skill（写清该项目特有的处理方法/数据 schema/检查项）→ 再 `agents.skills` 把 skill 装到对应 agent。
- 角色 → `agents.role`；工具 → `agents.tools`（如执行 agent 需要 `bash` 跑计算）；职责描述 → `agents.description`。
- 约束 → `agents.constraints`（超时/并发/重试）。
- 工作目录：平台按 agentId 自动派生 `workspaces/<agentId>`，agent 只用相对 `inbox/`、`outbox/`——**无需也无法手设绝对工作目录**。
- SOUL / wake-message：由 role + 已装 skill **自动组装**，不直接编辑。

## 6. 完成 → 预览（不要自己拍快照）
- 结构搭完，告诉用户"建好了：哪些 agent、什么结构、装了哪些领域 skill"。
- 用 `inspect.structure_preview`（projectStructureAfter）给用户**预览改动后结构**（新增/删除/修改的 agent 与边）。
- **不要 emit "拍快照" 的 step**：平台在破坏性 apply 前会自动拍结构快照兜底，且没有 operatorExecutable 的 capture surface。

## 7. 交付到此为止：结构 + agent 内容 + 预览（operator 不注入、不运行具体任务）
- 边连齐（含闭合成环）就是**结构 active**——这就是 operator 的交付终态，**结构建好而尚未喂任务不是缺陷，是设计完成的标志**。
- **具体任务由下游投递，不由 operator 注入**：线性管线与环形结构一样，由用户/ingress 把任务随 contract 投进入口 agent 的 `inbox/`，传送带逐跳推进；环形结构则沿闭合边一圈圈转。
- 平台没有任何 operator 可用的"起跑"surface：运行是下游 ingress/用户动作，build plan 到预览为止。

## 红线
- 图边 = **固定管线** + 传送带投递许可，就这两件事。产物入仓另有真值：上游身份随合约走（`contract.upstreamProducers`，派工收口登记），`assign_task` 这类主动协作的目标即使不在图上，上游产物包照样入仓。**按真实的工作流程连边即可，为了让产物流动而额外连边是多余的。**
- pipeline 出边保持唯一：ingress 首跳与 agent_end 自动选路都要求管线边唯一，把图连成网会让整条链在门口判成歧义。
- 改系统一律经 CLI-system surface（plan→execute→apply→verify），不裸写配置/文件。
- 领域走 skill，不进 SOUL。
- 破坏性操作（删 agent/automation）apply 前平台自动拍快照兜底（你不用也不能 emit 拍快照 step）。
- **operator 只设计、不执行**：交付物止于结构 + agent 内容 + 预览；结构 active 而未喂任务是正确终态；平台不提供任何 operator 可 emit 的起跑/注入 surface，运行属下游 ingress/用户动作。
