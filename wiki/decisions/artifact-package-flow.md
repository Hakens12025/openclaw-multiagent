# 产物随合约整包流转 (Artifact Package Flow)

> ⚠️ **落地形态已升级（v181 / 2026-08-08）**：`upstreamPackages` 从目录路径字符串升格成 `{path, producer, files[], primary}` 对象数组——清单由平台在拷贝时零成本产出并主动递送，agent 不再需要猜文件名。见[产物交接](../concepts/artifact-handoff.md)。以下正文保留当时原貌。
>
> ⚠️ **两处核心机制已改（v218 / 2026-08-19）**：① **留存店取消** —— `control-plane/artifacts/<cid>/<producer>/` 与 `saveAgentArtifact`/`preserve_artifact` 站整体删除。封条（seal）落地后树 outbox 就是不可变正本，下游一律直接对它取包（已封包→symlink 零拷贝，未封包→拷当前内容），副本店从 08-16 起再没被读过。② **上游不再按 graph 求** —— 原本按全部入边反查 producer，那是把「投递授权」当成「产物来源」，后果是 08-18 图夹具拆除后评审包投递静默断掉三天。现在上游身份随合约走：`contract.upstreamProducers`，由派工收口（`applyUpstreamProducerPointer`）一次登记。**正文第 9 行「随 contract 沿 graph 流到下游」与第 11 行的留存描述均已作废**，其余（整包、指针、agent 只读自己 inbox）不变。

> 上游 agent 的产物以「包」（全部文件 + manifest）随 contract 流到下游 inbox；agent 只读自己 inbox，系统负责搬运。

## 决策

agent 的产物（可能是多个文件）按 `contract+producer` 整包独立留存，并随 contract 沿 graph 流到下游 agent 的 inbox：

- **留存**：agent_end 把该 agent 全部产物文件整包存到 `control-plane/artifacts/<cid>/<producer>/` + `manifest.json`（身份/清单/主交付物）。每个 producer 独立一包，互不覆盖。
- **流转**：下游 `before_agent_start`（routeInbox）把上游 producer 的整包（全部文件，递归）复制到 `inbox/upstream/<producer>/`，并在 `contract.json` 写 `upstreamPackages` 指针。
- **消费**：agent 读自己 `inbox/contract.json` → 见 `upstreamPackages` → 读 `inbox/upstream/<producer>/` 的产物包，在其基础上续作。不跨路径读、不从零重做。

## 原因

- **协作断裂的根因**：此前 planner 的扩展产物没流给 worker，worker 看到的只有 contract JSON、各 agent 各自从零重做。产物必须真正流转才有协作。
- **产物可能是多文件**：单 `content.md` 不可行；系统搬运 outbox 的全部产物文件（含子目录）。
- **agent 只读自己 inbox**：系统负责按 graph 搬文件，agent 不跨路径读东西——这是传送带原则在产物维度的延伸（[传送带](../concepts/conveyor-belt.md)）。
- **不造第二真值**：manifest 只引 `contractId`，路由/状态机/来源仍是 contract 的真值（[合约](../concepts/contract.md)），manifest 不重复。manifest 由原 `runtime_result.json` 演进，不另造文件。

## 否决的替代方案

1. **唤醒消息嵌入上游产物正文（wake-embed）** — 临时实现过，但违背"agent 只读自己 inbox"：产物塞进 wake 是跨路径推送、且有大小上限要截断。已撤除，由包流转 + contract 指针替代。
2. **单 `content.md` 内容文件** — 产物常是多文件（报告 + 数据 + 附件），单文件装不下。改为整包搬 outbox 全部文件。
3. **manifest 里指定收件人/路由** — 会和 graph 抢真值。manifest 只做身份/清单，路由仍走 graph。
4. **靠 SOUL 自觉读全 inbox** — 不可靠（产物静默躺在 inbox 也不读）。改为 contract `upstreamPackages` 指针 + dispatch 指令显式引导。

## 影响

- `artifact-store.js`：`saveAgentArtifact`（整包 + manifest）、`copyUpstreamArtifactsToInbox`（整包流入 + 返回 packages）。
- `agent-end/stage-definitions.js`：`preserve_artifact` 阶段（graph_route 之前）传 `executionObservation.artifactPaths` 整包留存。
- `runtime-mailbox.js`：routeInbox 整包流入 + 写 `upstreamPackages` 指针。
- `role-spec-registry.js`：dispatch 指令加"读 upstreamPackages"通用引导（路径真值仍在 contract）。
- outbox 收集早已支持多文件 + 主交付物（`runtime-mailbox-outbox-helpers.js`），本决策只补"流到下游 inbox"这一缺口。

## 配套:角色重定义 + 模型适配结论

- **角色重定义**：planner 产「工作简报 +「STAGE」阶段计划」（理解/大纲/约束/该交付什么），worker 把上游简报当工作输入产真交付物（`role-spec-registry.js` / `soul-template-builder.js`）。修了 worker 复读 planner 产物的问题。
- **模型适配（诚实记录）**：让 planner 产「纯提纲、不写正文」用 MiniMax-M2.5 + 提示词**做不到**——三级强化后仍产完整正文，硬压还会让它不产简报。定为「planner 产结构化首版 → worker 加厚」可靠版。要纯提纲需换更听话的模型或硬路径改写任务。参见 [SOUL 作为通用机](soul-as-generic-machine.md)：role 行为属软路径，受模型遵循度约束。

## 出处

决策稿 `docs/decision-dual-file-package-flow-2026-05-31.md`（§10 含单交付物回退 + 角色重定义 + 模型结论）；落地于 v113 工作线。
