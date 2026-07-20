<div align="center">

# MultiAgent-OpenClaw-System-kksl

**多 Agent 协作平台 —— 代码控制流程，LLM 负责内容。**

-本项目基于@Openclaw 2026.03.02版本开发，后续未做适配，请注意

[![status](https://img.shields.io/badge/status-WIP-orange)](https://github.com/Hakens12025/openclaw-multiagent)
[![platform](https://img.shields.io/badge/platform-macOS-lightgrey)](https://github.com/Hakens12025/openclaw-multiagent)
[![node](https://img.shields.io/badge/node-22%2B-green)](https://nodejs.org/)

[快速开始](#快速开始) · [它能做什么](#它能做什么) · [它怎么工作](#它怎么工作) · [Operator 控制面](#operator-控制面) · [文档](#文档)

</div>

---

把多个 LLM agent 放进同一个工作空间，用一条传送带让它们协作：每个 agent 读自己的 inbox、处理、写 outbox 然后停下，平台按 graph 授权把产物投递给下一个 agent。换一套拓扑只改 JSON 配置，平台代码一行不动。

> 个人研究项目，还在持续演进。核心（inbox/outbox + graph 调度）稳定可用，日常在 macOS 上跑。想一起折腾 agent 架构的，欢迎 star / 提 issue。

## 快速开始

```bash
git clone https://github.com/Hakens12025/openclaw-multiagent.git ~/.openclaw
cd ~/.openclaw
cp openclaw.example.json openclaw.json   # 填模型 API key 和 gateway token
bash setup.sh
bash start.sh
```

打开 `http://localhost:18789/watchdog/progress?token=<你的 token>` 就是 Dashboard。

需要 Node 22+ 和 `openclaw` CLI（`npm install -g openclaw`）。

## 它能做什么

- **多渠道接入** —— WebUI / QQ / 飞书 / A2A 的消息进来，自动分流给合适的 agent
<!-- FIX(C9-doc-drift): evaluator 非真实角色 -> 改为真实角色 reviewer -->
- **并发执行** —— worker 池默认 6 路并行，planner 拆解、worker 干活、reviewer 评审
- **研究回路** —— 一个话题自动检索、整理、评估，不达标就再来一轮，直到收敛
- **实时 Dashboard** —— SVG 拓扑看消息怎么流，session 回放看每个 agent 的输入输出，系统提示词逐层展开
- **多模型** —— ARK（豆包 / MiniMax / GLM / DeepSeek / Kimi）、OpenAI 兼容、Anthropic、本地 Ollama，配置里切
- **可扩展** —— skill 按 agent 注入，hook 拦截工具调用，改一改 graph 就是一条新工作流

![OpenClaw 主控面](docs/screenshots/home.png)

> **主控面**：左侧工作项生命周期，中间实时运行时图（agent 沿 graph 边协作），右侧事件流实时滚动。

![工作流页](docs/screenshots/workflow.png)

> **工作流页**：连通分量拓扑总览 + session 查看器——点任意 agent，看它这一轮的输入 → 处理过程 → 输出。

## 它怎么工作

一条原则贯穿所有设计：**代码负责流程，LLM 负责内容。**

代码管确定的事——路由、状态机、调度、安全、质量门控；LLM 管模糊的事——理解任务、产出内容、解释结论。两边互不越界。

由此长出三个核心：

- **传送带** —— graph 的边是「谁能投给谁」的授权，不是时序。agent 之间从不直接通信，全靠平台按 graph 搬运 inbox/outbox。回路里绝不硬编码 agent 名字。
- **Contract** —— 每个任务是一份合约，带着 assignee 和 replyTo，落进 agent 的 `inbox/contract.json`。
<!-- FIX(C9-doc-drift): 角色清单缺 agent 且 executor 曾被拼错 -> 列全 6 个真实角色 -->
- **SOUL 通用机** —— agent 的 `SOUL.md` 只写通用行为（状态机、inbox/outbox 流程），agent 有不同的 Role——共 6 种：bridge、planner、executor、researcher、reviewer、agent。不同的Role才是各个agent的特有知识，同时可可自定义skill 注入。换个领域就是换套 Role，SOUL 一字不改。

## Operator 控制面

> 大多数多 agent 框架，要你**手写拓扑、手接边、手调 prompt**。OpenClaw-mulitagent-system-kksl 把这件事变成一句话：
>
> 「给 marketing 话题建一条 研究 → 撰写 → 评审 的回路，评审不过就重来」
>
> —— operator 理解你的意图、起草结构、在图上给你**预览**，你点同意，平台才真正动手。

**operator 是一个 meta-agent（治理 agent）：它不干具体活，只设计系统本身**——agent 拓扑、角色、prompt、skill、loop / group 结构。具体任务永远是普通 agent 在传送带上完成的。**控制面（怎么搭）和数据面（怎么干）彻底分开**——这是它和「会自己改自己」的系统最根本的区别。

#### 一句话 → 可运行结构，中间有四道关

```
你说一句话
   │
①  operator-brain     LLM 理解意图，起草结构方案（只设计，不执行）
   │
②  operator-plan      归一化 + 校验 + 可行性预检
   │                  （引用的 agent 必须真实存在，或在本计划内被创建——杜绝悬空边）
③  你审批             计划渲染成拓扑图上的 diff 预览叠层，加哪些 agent、连哪些边一目了然
   │                  同意才继续，不满意就丢弃
④  operator-executor  经 CLI-system 类型化接口落地；每步 apply 后强制启动一道 verify（把改动验回来）；多步 plan 中途某步失败 → 整体回滚到快照
```

#### 和现有架构不一样在哪

| | 多数多 agent 系统 | OpenClaw operator |
|---|---|---|
| **改结构** | 手写拓扑，或框架自动改 / 自我进化（ADAS、AFlow、GPTSwarm…） | **建议优先 + 人工审批**：operator 出提案，你点同意，平台才落地 |
| **落地方式** | 自由生成代码 / code-as-workflow | **类型化接口**：operator 只能产 `{surfaceId, payload}` 计划，**碰不到代码** |
| **可信度** | 改完直接跑，对不对看运气 | **强制 verify 门**：每步 apply 后强制启动一道 verify 把改动验回来；多步 plan 中途某步失败 → 整体回滚到快照 |
| **优化依据** | 主观判断，或需要标注数据集 | **客观证据**：skill / 结构从 `EvaluationResult` 评判沉淀，origin-hash 去重 |
| **系统知识** | 云向量库 RAG | **零依赖**：agent-map 是关键词打分的紧凑片段，极小本地模型也跑得起 |

读操作全部经 `inspect.*`（数十个观测源，永远新鲜），写操作全部经类型化 `apply.*` surface。operator 这条路额外多几道闸：`operatorExecutable` 权限校验 + 强制 verify + 多步快照/回滚；WebUI 的直接管理动作更轻，但和 operator **最终收口于同一个 admin-surface 节流点**——没有隐藏后门、没有第二条写路径。

#### 附带的治理能力

- **结构快照 / 回滚** —— 多步改动先拍快照，中途失败自动还原，绝不留半成品系统
- **实时预览叠层** —— 应用前在拓扑图上叠出这次会加哪些 agent、连哪些边、删什么，不满意就不应用
- **ProfileLifecycle 治理** —— 跟踪每个 agent 的可靠度（连续通过 → 信任等级 → 渐进收紧治理），退化时主动出优化提案，配全局熔断
- **skill 自动沉淀** —— 跑通且被客观评判认可的经验，自动结晶成可复用 skill（Hermes 式自我进化，但每一步都有人审，可选自动，可回退）

> 一句话总结这套设计的取舍：**让强模型负责「该怎么搭」的创造力，让平台代码负责「能不能落地、对不对、能不能撤」的确定性。** 自主，但不失控，这才是我认为harness设计的精髓。

## 设计小巧思

- 方便的WebUI，可直接管理agent（添加删除agent，prompt设计，使用的模型，agent间拓扑结构）
- 用户消息和系统内派工渠道分开，用户可以直接和系统内任意agent交流，同时可让某agent直接派工去往某个agent，或者是某个设计好的loop，完成后自动回流消息
- 用户消息和系统派工消息使用不同的prompt，系统派工prompt为专用的wake-agent-message，更加对应agent在系统中的角色
- Prompt分情况组装，skill头部强制注入上下文，记忆系统使用openclaw默认记忆系统
- 以 contract 为核心的 session 机制：每个 agent 对同一 contract 维持**自己的**会话（session key = `agent:<id>:contract:<cid>`），用 contract id 把跨 agent 的处理串起来——不是各 agent 共用一个 session，而是同一 contract 下各自保留上下文
- 多agent协作时，前一agent会生成context消息，以便后一agent上手开工
- harness设计为模块化，harness本身严格规范设计，倒逼operator设计和编写严格的harness模块
- 使用使用heartbeat方法避开了openclaw多并发缓慢的问题
- 设计了更好的排队系统，自动等待和自动派发更丝滑，相同contract享受相同session，同一agent再度处理该contract不会丢上下文
- 自带test-runner，3种预设test，在对系统，prompt进行修改后可直接复核质量
- 存在operator这个meta-agent，负责系统治理（修改系统agent拓扑，结构，prompt，skill，根据过往的历史运行记录自动发觉可优化的部分，张贴工单到operator页面，供用户选择），全操作使用harness和CLI system进行，无法直接edit代码，保证治理合规
- 整个结构可保存为实时预览的快照，用以预览operator对系统的修改，如有不满意可选择不应用
- 结构以保存码的形式储存，方便未来社区分享设计，分三级层次——纯编排结构、编排结构+agent内容、编排结构+agent内容+API key（用于个人结构复现）
- Token最小化为设计指导思想，不会堆prompt来限制agent的输出，极限使用过qwen3.5:0.9b模型最小上下文窗口运行该系统，简单任务依然能够跑通
- 

```
Gateway        加载 openclaw.json，注册插件
   │
Watchdog 插件   ingress 分流 · graph 调度 · loop 运行时
   │  inbox / outbox
Agent 层        每个 agent 一个 workspace，只看文件协议，不感知平台代码
```

## 文档

- **[SYSTEM_MAP.md](SYSTEM_MAP.md)** —— 10 分钟读懂全貌，从这里开始
- **[CLAUDE.md](CLAUDE.md)** —— 项目总纲：硬约束、代码红线、传送带原则
- **[SETUP.md](SETUP.md)** —— 详细安装与配置
- **[wiki/index.md](wiki/index.md)** —— 概念与架构决策索引

## 测试

```bash
cd extensions/watchdog
node test-runner.js --preset single         # 基础链路
node test-runner.js --preset concurrent      # 并发
node test-runner.js --preset research-flow   # 研究回路
```

报告写到 `~/.openclaw/test-reports/`。

<!-- FIX(C9-doc-drift): benchmark.js 是重复的第二条测试路径 -> 明确其弃用地位 -->
> 根目录的 `benchmark.js` 是早期独立自评脚本，已被 `test-runner.js`（唯一入口）取代，仅作历史参考，勿再扩展。

---

<div align="center">

不是成熟产品，是个还在长的东西。Issue 和 PR 都欢迎。

</div>
