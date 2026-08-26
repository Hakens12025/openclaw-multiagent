# 决策稿:双文件 per-session 包流转(产物随 contract 流转)

> ⚠️ **历史快照,勿当现状读**(标注于 2026-08-09)。此后已落地:动态协作不查图边(v179)、协作主路从 `[ACTION]` 标记换成 FC 工具、采集不再要求 `outbox/runtime_result.json` 提交令牌(v181)、`upstreamPackages` 升格为 `{path,producer,files[],primary}` 对象、`_manifest.json` 机制已删除。正文保留当时原貌。

> 日期 2026-05-31 · 状态 **待用户敲定**(敲定后重构传送带) · 起点 v112-stable
> 触发:工作流页暴露协作断裂——planner 产物没流到 worker(worker 没读、产物被覆盖);用户重申最初设计="系统按图传文件,agent 只读自己 inbox,产物双文件 per-session 流转"。

## 1. 问题(现状)
- planner 产出**没流到** worker:worker 只读 `inbox/contract.json`,漏读上游产物,自己重做。
- 产物**散落 + 覆盖**:`control-plane/output/<cid>.md` 各 agent 互写覆盖,planner 版本丢失。
- 我临时加的 `inbox/upstream/` + wake-embed 是**绕路**,非用户的包模型。

## 2. 设计原则(不可违)
- **系统负责按 graph 传文件**;**agent 只读自己路径下的 inbox,绝不跨路径读**(不读 control-plane/、不读别的 workspace)。
- **不造第二真值**:contract(execution_contract)仍是路由/状态真值;graph 仍是授权/路由真值。包里的"标识文件"是**索引/身份**,不是第二份路由真值。
- 沿用传送带:graph edge=授权,replyTo=回传,平台排队/唤醒。

## 3. 双文件 per-session 包模型
"双文件"= **双角色**:标识(1 个,系统读)+ 内容(**N 个产物文件**,agent 读)。**产物可能是多个文件,不是单 md**;系统搬的是 **outbox 里的所有文件**。
一次产出 = 一个 **per-session 包**(目录):
```
outbox/<package>/
  manifest.json        ← 系统读:身份/索引(属哪个 contract、产者、产出时刻、文件清单)
  <产物文件们 ...>      ← agent 读:实际产物,可 1..N 个(如 report.md / data.json / analysis/*.md,文件名由 agent 定)
```
系统按 graph 把整个包从**上游 outbox** 搬到**下游 inbox**(同名目录):
```
planner: outbox/<package>/        ──系统按 graph 搬──►   worker: inbox/<package>/
```
下游 agent **只读自己 `inbox/<package>/content.md`**(及自己的 `inbox/contract.json` 任务),拿到上游产物。**不跨路径。**

## 4. 标识文件 manifest.json(系统读,索引非真值)
建议字段(只做身份/索引,不重复 contract 路由真值):
```json
{ "contractId": "TC-...", "producer": "planner", "contentFile": "content.md",
  "producedAt": <unixMs>, "kind": "agent_artifact" }
```
- 系统读它知道:这是哪个 contract 的产物、谁产的、内容在哪。
- **路由仍走 graph**(系统按 `getEdgesFrom(producer)` / contract 的下一环决定投给谁),**不靠 manifest 指定收件人**(避免第二路由真值)。

## 5. 内容文件(agent 读,**可多个**)
- = 该 agent 产出的**所有文件**(1..N 个,不限单 md;如报告 + 数据 + 附件 + 子目录)。
- 系统**搬整包**(见 §6),下游 agent 读 `inbox/<package>/` 下**所有产物文件**续作(SOUL:读自己 inbox 含包目录,递归)。
- manifest 列文件清单供系统/页面索引;内容由 agent 直接读文件,不靠 manifest 转述。

## 6. outbox→inbox 搬运(系统,按 graph,何时)
- 上游 `agent_end`:把 outbox 里**所有产物文件** + 生成的 `manifest.json` 归拢为 `outbox/<package>/`(**graph_route 之前**,时序参照已修的 preserve_artifact)。
- 路由到下游时:系统按 graph 把**整个包(目录下所有文件,递归)**复制到下游 `inbox/<package>/`(整目录搬,不挑单文件;下游 before_agent_start 投 contract 的同时投包)。
- 独立留存:包同时归档到 `control-plane/artifacts/<cid>/<producer>/`(不覆盖,可追溯全链;给工作流页展示)。

## 7. agent 读法
- agent 只 `read` 自己 `inbox/` 下的东西:`inbox/contract.json`(任务)+ `inbox/<package>/content.md`(上游产物)。
- **不读** control-plane/、不读别的 agent workspace。这是通用 inbox 行为(归 SOUL 的"检查 inbox→读输入"步骤,读全 inbox 含包)。

## 8. 与现状 diff / 迁移
| 件 | 现状 | 目标 |
|---|---|---|
| 标识(系统) | `outbox/runtime_result.json` + `inbox/contract.json` | 包内 `manifest.json`(+ contract.json 仍作任务信封) |
| 内容(agent) | `control-plane/output/<cid>.md`(**单文件**,散落,不流转) | 包内**所有产物文件(1..N,含子目录)**,整包搬到下游 inbox |
| 搬运 | 无(内容不流) | 系统按 graph outbox→inbox 整包搬 |
| 我加的临时件 | `inbox/upstream/<a>.md` + wake-embed | **替换为包流转**(撤 wake-embed) |

## 9. 收敛定案(2026-05-31,已拍)

> 核心发现:系统的 outbox 收集**早已支持多文件 + 主交付物**(`runtime-mailbox-outbox-helpers.js`:`listCommittedOutboxFiles`/`artifactFiles`/`resolvePreferredPrimaryArtifactFile`/`primaryArtifactPath`)。所以这事比想象简单——**真正缺的只是把这些文件流到下一环 inbox**;manifest **由现有 `runtime_result.json` 演进,不另造**。

1. **包命名/位置**:agent 自己 `outbox/` 保持 flat(系统负责打包,agent 不管 session 文件夹)。系统投递到下游 **`inbox/upstream/<producer>/`**(按 producer 分,多上游天然安全)。
2. **标识文件**:演进现有 **`runtime_result.json` → 包内 `manifest.json`**(不另造)。字段:`contractId`、`producer`、`producedAt`、`files[]`(清单)、`primary`(主交付物)、`status`、`summary`。路由/状态机/来源仍是 **contract 的真值,manifest 不重复**(只引 contractId)。
3. **产物多文件**:**outbox 全部产物文件(1..N,含子目录)整包搬**(已支持)。`manifest.primary` 给终端投递/页面默认展示。
4. **多上游**:下游 inbox 每上游一个包 `inbox/upstream/<producer>/`,互不覆盖。
5. **旧件去留**:`control-plane/output/<cid>.md` **保留**(终端投递/页面用);`runtime_result.json` 演进为包内 `manifest.json`,路由职责并入(实为引用 contract,不新增真值)。
6. **agent 读包**:contract.json 加 **`upstreamPackages: ["upstream/<producer>/", ...]`** 指针(相对自己 inbox,不跨路径);agent 必读 contract → 据指针读包。比纯靠 SOUL 自觉强,比 wake-embed 干净。

**独立留存**:`control-plane/artifacts/<cid>/<producer>/`(整包所有文件 + manifest),供页面/审计,session-clean 不动。

### 实施步骤(开始做)
1. `artifact-store.js`:`saveAgentArtifact` 从"单 .md"→"存 outbox 全部文件 + 生成 manifest.json"到 `artifacts/<cid>/<producer>/`;`copyUpstreamArtifactsToInbox` 从"单 .md"→"整包复制到 `inbox/upstream/<producer>/`"。
2. `runtime-mailbox`:routeInbox 在 staging contract 后,投递每个上游包 + 在 contract.json 写 `upstreamPackages` 指针。
3. `dispatch-graph-policy.js`:**撤 wake-embed**(buildWakeMessage 回 base),由包 + 指针替代。
4. TDD(包搬运 + manifest + 指针 + 多文件)+ 串行门 ≤ 基线;跑 complex 验证 planner 多文件产物随包流到 worker 且被读。

## 10. 落地补充:单交付物回退 + 角色重定义(2026-05-31)

### 单交付物回退(关键修复)
线上验证发现:WebUI 链路 agent 把交付物**直接写到 `contract.output`**(不走 outbox),`executionObservation.artifactPaths` 为空 → `preserve_artifact` 不打包(回归了旧能力)。修复:`artifactPaths` 为空时回退 `[primaryOutputPath]`。因 `preserve_artifact` 在每个 agent 的 agent_end(下一环覆盖共享 output 之前)执行,各 producer 版本被正确快照。线上 multi/complex 实证:planner/worker/worker2 各产独立包,worker session 读了 `inbox/upstream/planner/`。

### 角色重定义(planner=简报 / worker=据简报产交付物)
- `role-spec-registry.js` + `soul-template-builder.js`:planner 产「工作简报 + [STAGE] 阶段计划」(理解/大纲/约束/该交付什么),worker 把上游简报当工作输入产真交付物;`CONTRACT_INBOX_READ_INSTRUCTION` 重述为"上游包=本轮 brief/input,据此产自己的交付物"(修了 worker 复读)。
- 文案守正向(过 `prompt-composition-minimal` 禁词守卫)。

### 模型适配结论(诚实记录)
**MiniMax-M2.5 靠提示词约束做不出"纯提纲"**:三级强化(SOUL 原则 → 提纲模板 → dispatch 重构"任务=执行节点的交付物")后,planner 仍产完整正文(complex-03 全文分析),最狠那版还让 planner 只写 runtime_result 不产简报(complex-02 协作丢失)。根因:`contract.task` 具体("写一份报告"),模型跟具体任务走,role 指令压不过。**已回退最狠版**,定为「planner 产结构化首版 → worker 加厚」可靠版(用户拍板接受)。要"纯提纲"需换更听话的模型或硬路径改写任务,本轮不做。
