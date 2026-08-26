# OpenClaw 项目总纲（2026-03-12）

本文件定义当前项目的硬约束、运行拓扑与维护规范。进入任何开发任务前先读一遍。

--

我们这是一个多agent平台，agent在其中是一个工作单元，平台为他们搭建了一个活动工作空间，所有的agent都在这个空间里面活动与工作，大家使用同一种语言，同一套时钟，同一种模式进行相互工作，通过对agent结构的调整，自动化的实现不同的工作与目标


## 1. 第一原则

**LLM 负责内容，代码负责流程。**

代码硬路径负责：
- 路由（inbox/outbox、delivery）
- 状态机（contract 生命周期、stage 推进）
- 调度（传送带 dispatch、排队、唤醒）
- 安全（before_tool_call、敏感信息拦截）
- 质量门控（阈值判定、阶段迁移）

### 传送带原则（Conveyor Belt）

**绝对禁止在传送带派工路径里硬编码 agent 名称或角色特化分支。**

传送带是唯一的 transport 原语：
- Agent 只负责：读 inbox → 处理 → 写 outbox → 停止
- 平台只负责：按 pipeline 边解下一跳 + 校验投递图边 → 排队 → 目标闲时自动投递 → 唤醒
- Graph edge = **固定管线定义 + 传送带投递授权**，不是时序控制；**也不是协作授权** —— agent 主动调 `assign_task`/`wake_agent` 时自己指定目标、不查图边，协作授权单源是 `lib/system-action/collaboration-intent-policy.js` 的角色表；**更不是产物来源** —— 上游身份随合约走（`contract.upstreamProducers`，派工收口 `applyUpstreamProducerPointer` 登记），2026-08-19 前用图入边反查上游，图夹具一拆评审包投递就静默断了三天
- 目标忙时排队（FIFO），目标闲时自动搬进 inbox
- 图上成环 = 传送带沿回边重复投递，不是独立协议（**2026-08-18 起没有回路运行时**：LoopSpec/LoopSession/start_loop 全部退役，环只由 `detectCycles` 识别并驱动前端高亮与提示词，不再有注册表、轮次与预算）
- 结果回传走 replyTo 路由元数据，不走 graph

反模式（绝对禁止）：
- 在 dispatch 逻辑里写 `if (agentId === "xxx")`
- 把相同的功能或事相似的路径翻来覆去造临时流程，最后堆积为相互交错的乱麻
- 为了满足某种特定要求而写的固定完全不可迁移的代码
- 为了实现当前agent拓扑结构能力而编写的以通用外衣伪装的专用代码
- 代码编写简洁且高质量，拒绝重复代码反复复制黏贴

### 代码质量红线

- **不留遗留代码**：废弃的函数、import、变量必须删除，不能注释掉或留 TODO
- **兼容层是临时的**：所有兼容 shim/wrapper 都必须标注生命周期，在下一个稳定 tag 前固化为正式代码并删掉兼容层
- **不为图方便而偷懒**：不使用的代码就是 bug 的温床，必须清理干净，过去的代码会干扰正常工作与计划，更会导致后续维护困难
- **一条路径原则**：必须保证平台真值唯一，只需要一条实现路径即可满足的功能不能随便新创造回路与协议
- **真实可靠**：不能猜测这个系统里面发生了什么，需要调研的文件请详细的列出来文件路径和参考代码行

### System Blocks 开工纪律

任何代码更新先声明一个 primary System Block。正式板块总图见 `wiki/concepts/system-blocks.md`，agent 交接页见 `docs/system-blocks/`。

执行前用板块检查确认改动归属：

```bash
node scripts/openclaw-block-check.js --primary <block-id>
```

`verification-docs` 可以支撑其他板块的测试和文档，但不拥有 runtime 真值。跨 3 个以上非支撑板块的改动必须先拆任务。



LLM 软路径负责：
- 任务理解与拆解文本
- 代码/分析产出
- 实验结论解释与自然语言回复

禁止把硬路径职责写进 SOUL 或 task 文本。

---

### 2.2 插件与通道

- 插件：`watchdog`、`qqbot` 启用
- 绑定：`qqbot`、`feishu` 消息都绑定到 `controller`（单前台，2026-08-26 起 `agent-for-kksl` 退役）
- Gateway：本地 `18789` 端口，token 鉴权


---

## 4. SOUL/HEARTBEAT 规范

每个 SOUL 必须包含：
1. 角色一句话（唯一职责）
2. 明确状态机分支
3. 固定处理步骤（检查 inbox -> 读输入 -> 产出 outbox -> 停止）
4. 输出结构约束
5. 绝对规则（相对路径、禁止越权）

硬规则：
- 只用相对路径（`inbox/`、`outbox/`）
- 不读取 `openclaw.json`
- 完成后立即停止，等待下次唤醒
- HEARTBEAT.md 仅保留一句转发语，不复制 SOUL 内容

---

## 5. 运维与测试

### 5.1 启动

```bash
bash ~/.openclaw/start.sh
```

该脚本会启动 SSH 隧道与 Gateway，并写日志到 `/tmp/openclaw-*.log`。

### 5.2 测试（唯一入口）

```bash
node ~/.openclaw/extensions/watchdog/test-runner.js                    # 默认 health（零 LLM 系统体检）
node ~/.openclaw/extensions/watchdog/test-runner.js --preset single    # 最小 live 派工链路
node ~/.openclaw/extensions/watchdog/test-runner.js --preset full      # 全部 suite 全量串行
node ~/.openclaw/extensions/watchdog/test-runner.js --list             # 打印 live 预设表
```

预设清单以 `--list` 的 live 输出为准（本文不复刻清单——复刻必然滞后；2026-08-18 回路退役后
对照 live 核得 13 个预设，`full` = 12 个 suite）。
每个检查产出 CheckResult，fail/blocked/skip 必带 `E-*` 错误码（注册表
`extensions/watchdog/lib/formal-runtime/error-codes.js`），报告 failures-first。

测试规则：
- 禁止手写 curl 冒充链路测试
- 优先看 `test-reports/`（`.txt` 先读 FAILURES FIRST 段，`.json` 是机器可读镜像），不要先 tail 全量日志
- 旧旗标 `--suite/--filter/--clean` 已退役，会硬报错

---

## 6. 前端风格（Dashboard）

- 技术栈：原生 HTML/CSS/JS
- 视觉方向：NASA Punk、平面化、信息可读优先
- 禁止重度装饰（大圆角、阴影、毛玻璃、霓虹）

主文件：`extensions/watchdog/ui/`（零构建 SPA，v233 起）与 `routes/` 子模块。

---

## 7. 关键目录

- `extensions/watchdog/`：主编排与 API 路由（已模块化）；前端零构建 SPA 在 `extensions/watchdog/ui/`
- `docs/system-blocks/`：System Blocks 板块 handoff 入口
- `control-plane/`：运行时真值与记账（`records.db` 是唯一记账真值，代码在 `extensions/watchdog/lib/record-plane/`）
- `research-lab/`：实验态运行产物目录（agent 实验代码与产物）
- `workspaces/`：各 Agent 工作区（统一存放点）
- `skills/`：运行时可注入技能
- `use guide/`：历史备忘录（含主备忘录）

---

## 7.5 系统分层与定址 (System Map)

全量分层·板块·功能 + 目录重排蓝图见 **`docs/system-map.md`**（多 agent 全库映射，11 层）。附录 §5 归位清单当前 389 条且非全量，定址时以 §2 板块表为主、清单为辅。

**描述问题用四段坐标**（从上到下越来越具体）：

> **`L{n} 层 · 板块 · 功能 · 问题`**
> 例：`L1 通讯 · Graph-router · drainIdleDispatchTargets · 目标闲置未被 drain`

| ID | 层 | 拥有什么 |
|----|----|----------|
| L0 | 内核·运行时 | gateway 进程/hook/state·store/会话追踪/agent_end 生命周期/崩溃·超时·硬停 |
| L1 | 通讯·传输协议 | 传送带派工/ingress/graph-router/dispatch/inbox·outbox/delivery/SSE/system-action |
| L2 | 协作·编排 | graph(固定管线+投递授权+环检测)/collaboration-intent-policy(协作授权单源)/agent-group(空间)/contract 状态机与结局判定 |
| L3 | Agent执行·安全沙箱 | before/after-tool-call/安全检查/执行预算/能力预设/dispatch跳数守卫/[ACTION]解析 |
| L4 | 提示词装配 | 六层装配/派工手拼/role persona/IDENTITY·SOUL/skill 头/漂移检测 |
| L5 | 交付·产物 | 上游产物整包流入(upstream-package-inflow,原 artifact-store 已收店 v218)/上游 context 有界注入·压缩/output 别名/可见产出判定 |
| L6 | 知识·RAG | embed/向量库/hybrid 检索·改写/rerank·judge/召回评测/多 KB/operator grounding |
| L7 | 验证·测试 | formal-runtime 测试验证/CheckResult·E-码/预设·suite·CLI（harness 塑形判定已退役 v226） |
| L8 | 调度·自动化 | schedule 触发/cron 物化/automation 注册·轮次驱动/收敛决策/治理画像 |
| L9 | 控制面·元层 | cli-system 四表面/operator·viz-master 大脑·执行器/structure-snapshot 回滚/admin-surface |
| L10 | 观测·前端 | 零构建 SPA `extensions/watchdog/ui/`(指挥台/透视/管理五子页)/routes HTTP 面（旧 dashboard 9 页已整删 v233） |

**目录重排已完成**（v171/v172，`docs/system-map.md` §4）：`lib/` 根从 82 松散文件收敛到 14，扩展根 39 个 `dashboard-*.js` 当时归入 `dashboard/`（该目录后随 v233 前端重制整删，现前端 = `extensions/watchdog/ui/` 零构建 SPA），其余按层进 `lib/{contract,session,stage,protocol,security,delivery,knowledge,prompt,routing,lifecycle,…}/`。新增文件按 System Blocks 归属放桶，不要再往根上堆。

---

## 8. Git 与安全

- `openclaw.json` 含密钥，严禁外泄
- 提交前先区分“代码变更”和“运行产物”（`research-lab/`、`test-reports/` 等）
- push 常用代理：

```bash
HTTPS_PROXY=http://127.0.0.1:8080 git push
```

---

## 9. 文档维护规则

- 结构调整后必须同步更新本文件
- 版本事实以代码和 `openclaw.json` 为准，不以历史备忘录文字为准
- 任何“行数/体量”描述都必须可由当前代码验证
