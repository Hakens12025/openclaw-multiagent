# submit_plan · 平台服务 FC 第一件 · 设计规格

> ⚠️ **§9 已裁决,本规格转为缓建**(2026-08-09,用户裁定)。
> - **①required 覆盖边界**:随 plan 缓建,暂不需答。
> - **②stages 上限**:机制定为**硬拒不截断**;数值待真建时定(现有论据指向低于 20——超限拒绝应是「该拆合约了」的信号,且 N stage = 前端 N 个勾)。
> - **③submit_output / report_progress**:`report_progress` 与 `submit_plan` 是**同一功能的两半**(plan 报 N 个 stage → agent 完成第 n 个报 progress → 前端实时打勾),**一起缓建**;`submit_output` **单独先建**,它扛着 `failed/awaiting_input/hold` 这三件平台不可知的事。
> 
> 因此本规格**不再是依赖链的解锁点**(先前把 §9 当「成本最低的解锁点」的判断已作废)。唯一仍要建的是 §8 第 1 步的地基(`PLATFORM_SERVICE_TOOLS` + `isExposedPlatformServiceTool` + before_tool_call 对称),供 `submit_output` 落地。见 [平台服务 FC 族](../../../wiki/decisions/platform-service-fc-family.md)。正文保留原貌。

- **日期**: 2026-08-06
- **状态**: 待用户审阅(未实施)
- **上位规格**: `2026-07-27-unified-fc-evidence-plane-design.md` §5/§6 与决议 21-25
- **测绘来源**: workflow wf_8fdf5fd4(三面:STAGE 全链 / 平台服务 FC 路径 / planMode 与期望吸收),全部锚点在当前代码核实
- **本规格回答**: submit_plan 长什么样、走哪条路、记什么账、planMode 三态落在哪、required 怎么被考官对账、三源覆写的真值规则、以及它**不做**什么

---

## 0. 一句话

`submit_plan` 是**平台服务 FC 族**的第一件:agent 把"我打算分几步做"结构化地交给平台,平台当场校验并物化成 `contract.stagePlan`,前端立刻可见,账本留痕。它**不跨 agent、不查图边、不开票据**,因此走一条与协作三件套**平行而非共用**的落地路径。

---

## 1. 边界(先说不做什么)

- **不做跨 agent 分工**(决议21 红线)。phase 的作用域是单 agent 会话,交棒不推进;多跳语义走角色分化/每跳期望/动态单腿工单。
- **不进 `INTENT_TYPES`,不进 `collaboration-intent-policy`**。理由见 §3.1——那会一次性污染四个消费点,并稀释协作授权表的语义。
- **不接角色矩阵**。"给自己排工序"任何角色都该能做,接入等于凭空造一条权限线。
- **不做 feature gate**(决议24):plan 阶段不限工具权限,越权拦截由 `before_tool_call` 守当。
- **不为 plan 造 L2 fence**:层级只设 L1(工具)/L3(`[STAGE]` 标记),与 spec 一致。
- **不新增 planMode 配置字段**。理由见 §4。

---

## 2. 工具面

### 2.1 参数 schema

```
submit_plan(
  stages: [{ label: string, note?: string }]   // 必填,>=1;顺序即执行序
  reason?: string                               // 覆写时说明为什么改计划
)
```

- `stages[].label` 是人类可读的步骤名;`id`/`order` 由平台铸造(`stage-${i+1}`),**执行者不可指定**——与 `contract.expectations` 同理:结构化真值归平台写。
- 上限:`stages` 长度设硬上限(建议 20)并在受理时拒绝超限,避免把 plan 当叙事容器。

### 2.2 受理凭证

复用**契约形状**而非函数本体:

```
{ accepted: true,  status: "accepted", stageCount: N, currentStageId: "stage-1" }
{ accepted: false, status: "invalid_params", code, reason }
```

三条硬约束(测绘核实):
1. `accepted` 字段名必须保留——考官判 fulfilled 的谓词是 `receipt.accepted === true`,单源。
2. 凭证 JSON **必须放进 `content[0].text`**——证据面只看得到 content 文本块,`details` 不进钩子;放错地方账本里只剩 `{bytes}`。
3. **不复用 `SYSTEM_ACTION_STATUS` 枚举**(那是跨 agent 投递状态机),平台服务族自带极小状态集 `accepted | invalid_params`。

### 2.3 注册与裁剪

- **第二次 `api.registerTool` 调用**(独立 entry、独立 names),不合并进协作族工厂——一族的工厂抛错会让该 entry 的**所有**工具消失,两族隔离。
- 工厂按 `toolContext.agentId` 每会话重算(框架侧已核实)。
- **裁剪要两道**:框架侧 `optional:true` + `tools.allow` 点名;工厂内部再自裁一次。原因:allowlist 写 `watchdog` 或 `group:plugins` 会一次性放行本插件全部工具,绕过按名裁剪——只靠 allowlist 的 off 态有逃逸口。
- `before_tool_call` 的角色白名单并集需要对称加一个 `isExposedPlatformServiceTool(toolName)`(**不带 role 参数**),否则受限角色(planner/reviewer)调 submit_plan 会被 L3 安全门直接 block。

---

## 3. 落地路径与记账

### 3.1 execute 直连本地 handler(不经 systemActionConsume)

协作族 execute 汇入 `systemActionConsume`,那里硬编码了角色策略、图边校验、票据、投递。submit_plan 三样都不需要。**为复用而给 consume 加"本地动作"分支 = 把不查图边的东西塞进查图边的门**,拒绝。

复用的是三段通用件:定义表 → 框架 tool 形状映射 → 凭证 JSON 化。自己写的只有 execute 的落点。

平台服务族需要一张**独立小名单**(`PLATFORM_SERVICE_TOOLS`),与 `collaboration-intent-policy` 平级:submit_plan 现建,submit_output / report_progress 照 create_task 先例登记为**缓建行**。

### 3.2 kind 判定:`internal × fc`(四条理由,其中一条是可复现的终态污染)

1. **定义**:kind = "作用面/执行走哪条路"。submit_plan 不跨 agent → internal。"平台受理"语义属于**凭证形状**,不该借 kind 表达。
2. **可复现的终态污染(最硬)**:记 collab 会被 `readSessionCollabFacts` 捞进 B5 合流,`synthesizeTraceSystemActionResults` 对任何 `accepted:true` 的事实合成 systemActionResults 条目,`selectPrimarySystemActionResult` 会选中它,`deriveSystemActionTerminalOutcome` 在"非 deferred + 无 executionObservation"时把合约判 **FAILED**,reason 写成 `submit_plan returned accepted`。即:**交了计划却没产出的会话会被判失败**。这是现成代码路径,不是理论风险。
3. **考官口径**:collab 事实会与 `expectedActions` 对账,submit_plan 混进去等于让"我给自己排了工序"去顶"我叫了下游"的期望位。
4. **反向副作用可控**:internal 事件不会被 `collectWriteEvents` 误认为产物目击(要求 args 同时有 path+hash);会进重复调用签名统计,同参数连交三次算一次 repeat burst——语义恰当。

**args 全量入账**(plan 结构本身就是证据),需在摘要注册表补 `submit_plan` 一行,否则证据只剩 `{keys:[...]}`。

### 3.3 物化与广播

复用现成桥:`materializeTaskStagePlan` → `contract.stagePlan` + `phases` + `total`,`buildInitialTaskStageRuntime` → `stageRuntime`,SSE 广播 `CONTRACT_STAGE_PLAN_UPDATED`,前端"有 plan 才显示 phase"门已实现。**会话中即物化**,前端立刻显示——这是相对 `[STAGE]`(要等 agent_end)的主要收益。

规范形状(测绘确认,不新造):
```
stagePlan   = { version, contractId, stages:[{id:"stage-N", label, ...}], revisionPolicy }
stageRuntime= { version, currentStageId, completedStageIds:[], revisionCount, lastRevisionReason }
```

**DIRECT 信封无正本文件**,物化要走内存镜像(`trackingState.contract` + `effectiveContractData`)而非只写快照——这是 P3 live 踩过的坑,复用既有写法。

---

## 4. planMode 三态:不是配置字段

三态的**物理承载点**分别是:

| 态 | 承载 | 含义 |
|---|---|---|
| `off` | `tools.allow` 不点名 submit_plan(默认) | 不给工具 + 无期望 |
| `auto` | `tools.allow` 点名 | 可选自决 |
| `required` | `contract.expectations` 里有条目 | 考官对账 |

**为什么不落 executionPolicy**(测绘给的硬证据):那一层的白名单与消费者已经脱节——`maxToolCalls` 配了会被 `sanitizeBindingPolicies` 静默吞掉,`execution-policy-defaults.js` 里"配置可覆盖"的注释今天是死话。往里加 planMode 等于**预定下一个 `planRequired`**(刚清葬的死字段)。

**spec 措辞需修正两处**:
- `plan_output_guard` **从来不存在**(全库零命中,只在已标 `[过时]` 的备忘录提案表里)。所以"required 是它的期望化替身、旧守卫退役"是空动作。
- required 有**真实覆盖缺口**:期望今天唯一的活写入点是 assign_task 参数,而 `buildHopExpectations()` 恒 null。**没有派工上家的跳(ingress 直入、loop 首跳)无处写 required**。这暴露一条语义事实:**required 是派工方的要求,不是被派方的属性**。本设计的选择:承认这个边界——required 只在有派工上家时可用;无上家的跳保持 auto 语义。要覆盖全部跳,需要图 schema 支持期望定义,那是 spec 之外的扩展,另行排期。

---

## 5. 期望表达:`expectations` 补第三块

```
expectations = {
  requiredArtifacts:   [{ path, required }],       // 产物
  expectedActions:     [{ intent, target, required }],  // 协作动作(协作授权表词汇)
  expectedSubmissions: [{ tool, required }],       // 平台服务提交(服务表词汇)  ← 新增
}
```

- 词表取自 `PLATFORM_SERVICE_TOOLS`,与协作表**平级、各自单源、互不污染**。
- 受理校验仍在 `normalizeContractExpectations` 内(同一函数、同一拒绝路径),写入点不变(assign_task 参数 + buildHopExpectations 挂点),"期望只归平台写"零破坏。
- **否决的两个候选**:把 plan 表成 `requiredArtifacts` 的文件路径(考官靠 write 事件+盘上 sha256 复核,对控制面 JSON 完全失明,还会诱导 agent 去写文件而不是调工具);不进 expectations、让考官按 stagePlan 来源隐式判(违反决议10"判据必须显式",且逼考官猜三源覆写次序,正是要消灭的考古式判定)。

### 考官侧改动(小)

新增一个 `collectSubmissionEvents`(按 `kind:internal` + name 命中服务表 + `outcome:ok`,**同约定界**)与一个 check 函数;`expectationChecks` 多一种 kind,**条目形状不变**(kind/target/required/verdict/evidence),因此 verdict 聚合(只按 required 过滤)与 health 的判决 schema 校验(只校验 verdict 枚举)**零改动**。

---

## 6. 三源覆写:真值单值 + 历史入账

三源(决议22):①派工先验(assign 带 `phases`,已通)②planner 上家跳 ③agent 自摸(submit_plan)。**后到覆写先到**,理由是信息量单调递增。

- 真值面保持单值:`contract.stagePlan` 永远只有一份当前计划。
- 覆写必须留痕:复用上批已落地的 `stage_plan_overwritten` 合成事件(kind:internal,args 记 previousSource/nextSource/前后阶段数)。**但现有触发点在 agent_end 提取时**,submit_plan 是**会话中途**覆写——需要在工具 execute 侧另接一次同款记账(同 name、同 args 形状,`nextSource: "submit_plan"`)。
- `stageRuntime` 的处理:覆写计划时 `revisionCount + 1`、`lastRevisionReason` 取工具的 `reason` 参数;已完成阶段 id 若在新计划中不存在则丢弃(不做跨计划映射,避免猜)。

---

## 7. planner 升级(决议25)

planner 与 plan-mode **共用同一个 submit_plan**,区分只有一句话:**plan 的作者与受益人是否同一人**。

- `PLANNER_OUTPUT_DIRECTIVES` 文案更新:plan 结构走 FC,brief 仍写文件。
- `[STAGE]` 文本路**保留**(降级容错,与 `[ACTION]`/`[FINDING]` 家族对称),不删。
- planner 的 `tools.allow` 增列 submit_plan。

---

## 8. 实施顺序(建议)

1. `PLATFORM_SERVICE_TOOLS` 表 + `isExposedPlatformServiceTool` + before_tool_call 并集对称(地基,单测)
2. submit_plan 工具面(定义/校验/凭证)+ 第二次 registerTool + 工厂内自裁(单测)
3. execute 落点:物化 + 内存镜像 + SSE + 覆写留痕(单测)
4. `expectedSubmissions` 字段 + 受理校验 + 考官 check(单测)
5. planner 文案与 tools.allow(lint 自查)
6. live 验收:新增探针案(planner 会话中调 submit_plan → 前端可见 → 覆写留痕在账 → required 期望被考官判 fulfilled)

---

## 9. 待用户裁决的三点

1. **required 的覆盖边界**:承认"只在有派工上家时可用"(本设计的选择),还是本期就给图 schema 加期望定义?
2. **`stages` 上限取值**:建议 20,是否合适?
3. **submit_output / report_progress 是否同批登记为缓建行**(只占位、不建),还是等各自触发条件到了再动表?
