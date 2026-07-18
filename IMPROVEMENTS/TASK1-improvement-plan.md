# 系统化改进方案（Task 1）

> 面向 openclaw-multiagent 的代码级改进方案。每条都标注「**什么问题** → **怎么解决**」，
> 附影响文件与验证方式。方案已在 Task 2 落地到分支 `improvements/systematic-review-2026-07`。
>
> 分层：**Tier A** = 外科式安全/正确性修复（已应用 + 新增单测跑绿）；
> **Tier B** = 新增能力（function-calling 双通道、agent 互通压缩，纯核心已单测，LLM 集成点明确标注）；
> **Tier C** = 文档/一致性（doc-only，附守卫测试防再漂移）。
>
> 全部遵守仓库宪法（CLAUDE.md）：LLM 管内容 / 代码管流程、传送带原则（dispatch/loop 内禁止硬编码 agentId）、
> 一条路径原则（真值唯一）、不留遗留代码。每处改动点带 `// FIX(<id>): 什么问题 -> 怎么解决` 注释。

---

## Tier A — 外科式安全 / 正确性修复

### A1 · 路径边界校验统一（安全）
- **什么问题**：`hooks/before-tool-call.js` 的 harness 沙箱边界用朴素字符串前缀 `targetPath.startsWith(normalizePath(root))`，
  导致 `"/ws-evil/secret.txt"` 能通过 `"/ws"` 允许根（沙箱逃逸）。同一文件还并存一份本地 `isInsidePath` 与
  `harness-module-evidence.js` 的规范 `isPathInsideRoot`——三份路径包含判断，弱的那份在关键授权路径上。
- **怎么解决**：全部收敛到唯一规范实现 `isPathInsideRoot`（基于 `relative()`，正确处理兄弟前缀与 `..`）。
  删除本地重复 `isInsidePath`，4 处调用点改用规范实现，第 359 行的漏洞前缀匹配换成 `isPathInsideRoot(targetPath, root)`。
- **文件**：`hooks/before-tool-call.js`；**测试**：`tests/before-tool-call-path-guard.test.js`（新增兄弟前缀逃逸回归）。

### A2 · 派发跳数 / 扇出 / A→B→A 环路守卫（安全）
- **什么问题**：派发跳数无上限，A↔B 互相派活只要每跳内容不同就能永远乒乓（各是独立 session，
  per-session 循环检测抓不到）。全仓无 `maxFanout`/`hopCount`/`dispatchDepth`。
- **怎么解决**：新增纯模块 `lib/routing/dispatch-depth-guard.js`——契约上携带 `dispatchDepth` + `originChain`
  运行时计数器；在唯一派发choke point `dispatchSharedToAgent`（图授权通过之后）读取并评估，超限硬停（`MAX_DISPATCH_DEPTH=32`
  绝对回退；`MAX_ORIGIN_CHAIN_REPEAT=6` = 2×默认 loop 轮数，乒乓在深度 ~12 处被截而合法 3 轮 loop 不受影响）。
  计数只在真实 dispatch 分支加一次（非 enqueue），保证排队/drain 的条目不会被新判 blocked（无 queue-lease 泄漏）。
  纯计数器，零 agentId 分支——图授权（edge=授权）不动，这是叠加的安全层。
- **文件**：`lib/routing/dispatch-depth-guard.js`(新)、`dispatch-graph-policy.js`、`dispatch-execution-contract-entry.js`；
  **测试**：`tests/dispatch-depth-guard.test.js`(新) + 现有 dispatch 集成测试全绿。

### A3 · 写入内容字节上限（安全）
- **什么问题**：`before_tool_call` 从不检查 write/edit 内容字节数，agent 可写任意大文件到磁盘
  （disk_full 只在 error-ledger 事后记录）；40000 字符的 cap 只截断「注入下游的视图」，不限制落盘。
- **怎么解决**：`lib/security.js` 提取单一 `collectWriteContent`（写内容字段的唯一真值），新增纯函数
  `checkWriteSize(toolName, params, maxWriteBytes)` 用 `Buffer.byteLength` 度量真实字节，超 `DEFAULT_MAX_WRITE_BYTES=5MB`
  即拦截。在 before-tool-call 的通用 1x 守卫族加一道 `1e. WRITE SIZE CAP`，预算经既有 `executionPolicy` 通道解析（可 per-binding 覆盖）。
- **文件**：`lib/security.js`、`lib/execution-policy-defaults.js`、`hooks/before-tool-call.js`；**测试**：`tests/write-size-cap.test.js`(新)。

### A4 · 累计工具输出字节预算硬停（安全）
- **什么问题**：`after_tool_call` 限制了工具调用**次数**（maxToolCalls=50）和重复（loop-detection），
  但从不限制总输出**体量**——单 agent 产生海量工具结果没有硬停。
- **怎么解决**：`HARD_STOP_REASON` 新增 `OUTPUT_BUDGET_EXHAUSTED`；`resolveMaxOutputBytesFromPolicy`（默认 20MB）；
  `measureToolResultBytes`（从唯一知道 result 形状的 `runtime-user-facing-output.js` 度量）；
  在 after-tool-call 紧跟 maxToolCalls 块累加 `t.outputBytesTotal`，越预算即 `markSessionHardStopped`——
  复用既有 `getSessionHardStopReason → terminalizeHardStoppedRuntimeSession` 链，终态 FAILED，无新协议。
- **文件**：`loop-detection.js`、`execution-policy-defaults.js`、`runtime-user-facing-output.js`、`hooks/after-tool-call.js`、
  `hard-stop-terminalize.js` + `agent-end-graph-route.js`(两处并行 summary 同步)、`session-tracking-state.js`；**测试**：`tests/output-budget-hard-stop.test.js`(新)。

### A5 · 工具预算按角色分档（正确性/一致性）
- **什么问题**：`getDefaultExecutionPolicy(role)` 对所有角色返回同一个 maxToolCalls(50)，与其角色化的 API 名不符。
- **怎么解决**：新增冻结 `ROLE_POLICY` 映射：bridge 15（hook-locked 转发）< reviewer/planner 30（读为主）< agent 50（floor）<
  executor/researcher 80（干活/检索重）。未知角色回退 floor，falsy 角色仍返回 null（契约不变）；
  `mergeExecutionPolicy` 语义不动——配置的 maxToolCalls 仍覆盖角色默认。
- **文件**：`lib/execution-policy-defaults.js`；**测试**：`tests/execution-policy-max-tool-calls.test.js`（更新断言 + 新增分档校验）。

### A6 · 事件事故存储 TTL + 有界淘汰（防泄漏）
- **什么问题**：`lib/runtime/execution-incident-store.js` 是纯内存 Map，无 TTL、无容量上限——长跑进程只增不减。
- **怎么解决**：复用 pending-signal-registry 的 TTL 风格：`INCIDENT_TTL_MS=30min`（基于既有 `updatedAt` 空闲计时，
  活跃 amplify 的事故不过期）、`MAX_INCIDENTS=500` LRU（upsert 时 delete+set 重排到尾，头即淘汰victim）。
  所有删除走单一 `deleteIncidentEntry`（clear/TTL/LRU 共用，消除重复清理）；读路径惰性过滤过期项。
  新增可选 `{now}` 时钟缝供确定式测试，4 个既有单参调用点不变。
- **文件**：`lib/runtime/execution-incident-store.js`；**测试**：`tests/execution-incident-store-ttl.test.js`(新)。

---

## Tier B — 新增能力（旗舰）

### B7 · `[ACTION]` 双通道（结构化 function-calling）+ 注入加固
- **什么问题**：所有派工/系统动作都靠 agent markdown 里的**文本标记** `[ACTION]` 正则解析：(1) 能力强的模型无法用真正的
  结构化调用；(2) **注入面**——外部用户文本被 bridge agent 复读，只要含 `[ACTION] delegate ...` 就可能触发特权动作（OWASP LLM01）。
- **怎么解决**（向后兼容，单函数单真值）：
  - **结构化通道**：新增 ` ```action ` 围栏 JSON 块，走**同一** `normalizeSystemIntent`（下游 intent 一致，无第二协议）。
  - **来源守卫（两层，都在「provenance」概念下）**：(i) 永远生效的结构规则——围栏状态机使得**非 `action` 围栏内**
    或 **blockquote(`>`) 内**的标记一律忽略（复读/引用的用户内容无法仅凭字节触发动作）；(ii) 每会话 nonce（能力令牌）——
    runtime 提供 nonce 时，标记必须携带（文本 `[ACTION:<nonce>]` 或 JSON `"provenance":"<nonce>"`）否则拒绝；
    nonce 只存在于 agent 系统提示词，用户复读的内容无法携带。默认无 nonce = 保持今日行为（向后兼容）。
  - provenance 在产出 intent 前被剥离（属传输元数据，非内容——守 LLM 管内容/代码管流程）。
- **纯解析器 + 守卫已完整单测**；**集成点（明确标注，非本次单测范围）**：把 nonce 注入 agent SOUL/系统提示词，
  并在消费端从 `contract.provenanceNonce` 取值（已接线，默认 null）。
- **文件**：`lib/action-marker-parser.js`(重写)、`lib/lifecycle/agent-end-stage-definitions.js`(接线)；
  **测试**：`tests/action-marker-structured.test.js`(新，9 例含注入拒绝) + 现有 4 例解析测试不变全绿。
- **并行（未在本次 watchdog 侧落地，需 build）**：`extensions/qqbot/src/dispatch-marker.ts` 是更暴露的 QQ 注入面，
  应施加同构的双通道 + 可选 nonce（见方案文末「后续」）。

### B8 · 上游上下文有界注入 + 溢出压缩 + 复制失败可见化（agent 互通压缩）
- **什么问题**：跨 agent 交接把上游整包**无上限**递归复制进 `inbox/upstream/<producer>/`——上游产物越滚越大撑爆下游上下文；
  且单包复制失败只 `logger.warn`（下游读 inbox 看不到、静默缺料）。
- **怎么解决**：新增纯模块 `lib/context-compression.js`：唯一预算真值 `computeContextBudgetPlan({files,maxBytes})`
  （贪心，溢出文件不占用字节池，`MAX_UPSTREAM_INBOX_BYTES=2MB`）+ 纯构建器 `buildCompressedManifest`（溢出文件→
  `COMPRESSED_MANIFEST.md`，列 path+size+截断 head，只读文件头 N 字节不整读）+ `buildMissingMarker`（失败→可见 `_MISSING.md`）。
  重写 `copyUpstreamArtifactsToInbox`：枚举带大小→跨上游共享字节池取舍→装得下的整包复制、溢出的落压缩清单、
  失败的落 `_MISSING.md`。返回形状严格保持 `{copied, packages}`。`runtime-mailbox.js` 指针门从 `copied>0` 改为
  `packages>0`（仅压缩的上游也拿到 upstreamPackages 指针）。**LLM 摘要是集成点**（调用侧可用 head 喂模型生成 summary 再传入），
  模块本身不耦合任何模型 SDK。
- **文件**：`lib/context-compression.js`(新)、`lib/lifecycle/artifact-store.js`、`runtime-mailbox.js`；
  **测试**：`tests/context-compression.test.js`(新，11 例) + `tests/artifact-flow.test.js` 回归全绿。

---

## Tier C — 文档 / 一致性（doc-only）

### C9 · 角色/花名册文档漂移对齐 + benchmark/隧道重复标注
- **什么问题**：真实角色恰 6 个（`AGENT_ROLE`：bridge/planner/executor/researcher/reviewer/agent），但 `SYSTEM_MAP.md §3`
  角色表列了不存在的 **evaluator** 角色、把 agent-id **contractor** 当角色，三份花名册（example.json / metadata / README）互相矛盾；
  README 有 `excutor` 拼写错误、缺 agent 角色；`benchmark.js` 与正式 `test-runner.js` 双测试路径（违反一条路径原则）；
  `start.sh` 与 `ssh-tunnel.sh` 隧道策略分歧无交叉引用。
- **怎么解决**（零运行时改动）：重写 SYSTEM_MAP §3 角色表对齐 6 真实角色 + example.json 花名册（注明 operator/viz-master 是 meta-agent
  按 agent-id 挂载、evaluator 已去特化）；删 §1 陈旧 `test` bridge；修 README 的 evaluator/excutor；给 benchmark.js 加 DEPRECATED banner +
  README 弃用注；给 ssh-tunnel.sh/start.sh 加隧道策略对账注释。新增守卫测试从 `AGENT_ROLE` 导入锁死文档，防再漂移。
- **文件**：`SYSTEM_MAP.md`、`README.md`、`benchmark.js`、`ssh-tunnel.sh`、`start.sh`；**测试**：`tests/agent-role-doc-sync.test.js`(新)。

---

## 后续（超出本次范围，已记录）
1. **B7 qqbot 侧**：`extensions/qqbot/src/dispatch-marker.ts` 施加同构双通道 + nonce，需 `npm run build` 重建 dist，属集成/需 TS 构建，本次仅在 watchdog 侧落地并单测。
2. **B7/B8 LLM 集成点**：nonce 的 SOUL 注入、溢出正文的 LLM 摘要——「LLM 管内容」侧，接线已就位，需 live gateway 验证。
3. **隧道收敛**：下一个稳定 tag 前把 `ssh-tunnel.sh` 冗余 `-L` 分支删除、收敛为一条隧道路径（本次仅文档对账，未删代码，守 scope discipline）。
4. **可观测性对齐 OTel GenAI 语义约定**（现有轨迹数据结构齐全，缺映射层）——独立工程。

---

## 验证摘要
- 每个 Tier A/B 修复都新增 node:test 单测并**单独跑绿**。
- **全量回归**：分支 vs 原始基线各跑 `node --test tests/*.test.js`——**失败文件集合完全一致**（52 个均为
  Windows 路径分隔符 / 需 live gateway / 缺运行时文件等**既有平台失败**），分支另**新增 59 个通过测试**、**零回归**。
- 平台为 macOS + live openclaw gateway，本机（Windows）无法端到端跑整平台；运行时集成路径为「diff + 单测」验证，非 E2E。
