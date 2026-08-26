<div align="center">

# OpenClaw MultiAgent System

**多 Agent 协作平台 —— 代码控制流程，LLM 负责内容。**

本项目基于 @OpenClaw 2026.03.02 版本开发，后续未做上游适配，请注意

[![status](https://img.shields.io/badge/status-WIP-orange)](https://github.com/Hakens12025/openclaw-multiagent)
[![platform](https://img.shields.io/badge/platform-macOS-lightgrey)](https://github.com/Hakens12025/openclaw-multiagent)
[![node](https://img.shields.io/badge/node-22%2B-green)](https://nodejs.org/)

[快速开始](#快速开始) · [它能做什么](#它能做什么) · [它怎么工作](#它怎么工作) · [Operator 控制面](#operator-控制面) · [文档](#文档)

</div>

---

把多个 LLM agent 放进同一个工作空间，用一条传送带让它们协作：每个 agent 读自己的 inbox、处理、写 outbox 然后停下，平台按 graph 授权把产物投递给下一个 agent。换一套拓扑只改 JSON 配置，平台代码一行不动。

> 个人研究项目，还在持续演进。核心（inbox/outbox + graph 调度 + SQLite 记账）稳定可用，日常在 macOS 上跑。想一起折腾 agent 架构的，欢迎 star / 提 issue。

## 快速开始

```bash
git clone https://github.com/Hakens12025/openclaw-multiagent.git ~/.openclaw
cd ~/.openclaw
cp openclaw.example.json openclaw.json   # 填模型 API key 和 gateway token
bash setup.sh
bash start.sh
```

打开 `http://localhost:18789/watchdog/?token=<你的 token>` 就是前端（零构建 SPA：指挥台 / 透视 / 管理）。

需要 Node 22+ 和 `openclaw` CLI（`npm install -g openclaw`）。

## 它能做什么

- **多渠道接入** —— WebUI / QQ / 飞书的消息统一进 controller 前台分诊，用户也可直接与任意 agent 对话
- **并发派工** —— 同一 agent 忙位唯一、FIFO 排队自动激活，多合约并发不丢上下文（同一 contract 恒复用同一 session）
- **单一记账真值** —— 所有运行事件（run_event / trace_event）落一张 SQLite 账（`control-plane/records.db`），全局序 + 因果边，账物对账脚本一条命令体检
- **执行模型可追溯** —— 每份合约每一跳实际用了哪个 provider/model，从会话转录观测提取，进账进正本（failover 换挡后记录的是真相而不是配置）
- **实时前端** —— 指挥台看运行时图与事件脉搏，透视页按 线程 → run → 合约 逐层下钻：时间线、参与者会话转录、系统提示词逐层展开
- **多知识库 RAG** —— per-KB 建库与召回评测、时序元数据、跨源分歧标注，agent 经统一检索面取知识
- **多模型** —— Kimi / GLM / ARK / OpenAI 兼容 / 本地 Ollama（embed），配置里切，失联自动 failover
- **可扩展** —— skill 按 agent 注入，hook 拦截工具调用，改一改 graph 就是一条新工作流

## 它怎么工作

一条原则贯穿所有设计：**代码负责流程，LLM 负责内容。**

代码管确定的事——路由、状态机、调度、安全、质量门控；LLM 管模糊的事——理解任务、产出内容、解释结论。两边互不越界。

由此长出三个核心：

- **传送带** —— graph 的边是「谁能投给谁」的投递授权，不是时序控制。agent 之间从不直接通信，全靠平台按 graph 搬运 inbox/outbox。派工路径里绝不硬编码 agent 名字。
- **Contract** —— 每个任务是一份合约，带着 assignee、replyTo 与上游产物指针（`upstreamProducers` 随合约走），落进 agent 的 `inbox/contract.json`；合约状态机由平台推进，结局判定不看正文长相只看流程事实。
- **两族角色** —— 系统只有 **executor**（干活）和 **controller**（分诊/派工）两族，研究、评审、施工这些分支只经提示词与工具面区分。SOUL.md 只写通用行为，领域知识全部经 skill 注入——换个领域就是换套 skill，平台一字不改。

```
Gateway        加载 openclaw.json，注册插件
   │
Watchdog 插件   ingress 分流 · graph 调度 · 合约状态机 · 记录面（records.db）
   │  inbox / outbox
Agent 层        每个 agent 一个 workspace，只看文件协议，不感知平台代码
```

## Operator 控制面

> 大多数多 agent 框架，要你**手写拓扑、手接边、手调 prompt**。OpenClaw 把这件事变成一句话：
>
> 「给 marketing 话题建一条 研究 → 撰写 → 评审 的管线，评审不过就打回」
>
> —— operator 理解你的意图、起草结构、在图上给你**预览**，你点同意，平台才真正动手。

**operator 是一个 meta-agent（治理 agent）：它不干具体活，只设计系统本身**——agent 拓扑、角色、prompt、skill、group 结构。具体任务永远是普通 agent 在传送带上完成的。**控制面（怎么搭）和数据面（怎么干）彻底分开**——这是它和「会自己改自己」的系统最根本的区别。

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
| **可信度** | 改完直接跑，对不对看运气 | **强制 verify 门**：每步 apply 后强制验回；多步 plan 中途失败 → 整体回滚到快照 |
| **系统知识** | 云向量库 RAG | **零依赖**：agent-map 是关键词打分的紧凑片段，极小本地模型也跑得起 |

读操作全部经 `inspect.*`（数十个观测源，永远新鲜），写操作全部经类型化 `apply.*` surface。operator 这条路额外多几道闸：`operatorExecutable` 权限校验 + 强制 verify + 多步快照/回滚；WebUI 的直接管理动作更轻，但和 operator **最终收口于同一个 admin-surface 节流点**——没有隐藏后门、没有第二条写路径。

#### 附带的治理能力

- **结构快照 / 回滚** —— 多步改动先拍快照，中途失败自动还原，绝不留半成品系统
- **实时预览叠层** —— 应用前在拓扑图上叠出这次会加哪些 agent、连哪些边、删什么，不满意就不应用
- **第二 meta-agent（viz-master）** —— 经同一套类型化 surface 产出可视化图表，实时 SSE 绑定数据源
- **结构保存码** —— 整套编排结构可导出为分享码，分三级：纯编排结构 / 结构+agent 内容 / 结构+内容+密钥（个人复现用）

> 一句话总结这套设计的取舍：**让强模型负责「该怎么搭」的创造力，让平台代码负责「能不能落地、对不对、能不能撤」的确定性。** 自主，但不失控。

## 设计原则（从事故里长出来的）

- **多主体真值，写者身份进门** —— 每份共享真值只有一个属主模块；写者带身份落日志；默认值站安全侧。测试进程的存储根结构性落沙箱（店根门卫），测试永远碰不到生产账
- **观测优先于配置** —— 记录"实际发生了什么"而不是"配置想要什么"（执行模型字段、会话转录归档、封条 outbox 都是这个思路）
- **结构大于纪律** —— 靠流程约定守住的东西迟早会破，能用结构挡住的就不留给自觉
- **一条路径原则** —— 平台真值唯一，同一功能不造第二条协议；退役的机制删干净不留兼容层
- **公开仓同步带门禁** —— `scripts/public-sync.js`：rsync + 真值精确脱敏 + 双扫描门（真值零泄漏硬门 / pattern 比对 baseline 审计门），扫描不过拒绝 commit

## 文档

- **[SYSTEM_MAP.md](SYSTEM_MAP.md)** —— 入口与导览，从这里开始
- **[CLAUDE.md](CLAUDE.md)** —— 项目总纲：硬约束、代码红线、传送带原则
- **[SETUP.md](SETUP.md)** —— 安装与配置
- **[docs/system-map.md](docs/system-map.md)** —— 系统分层全图（11 层，L0 内核 → L10 观测前端）
- **[wiki/index.md](wiki/index.md)** —— 概念与架构决策索引

## 测试

```bash
cd extensions/watchdog
node test-runner.js                    # 默认 health：零 LLM 系统体检
node test-runner.js --preset single    # 最小 live 派工链路
node test-runner.js --preset full      # 全部 suite 串行全量体检
node test-runner.js --list             # 打印全部 12 个预设
```

每个检查产出 CheckResult，失败必带 `E-*` 错误码，报告 failures-first 写到 `~/.openclaw/test-reports/`。

---

<div align="center">

不是成熟产品，是个还在长的东西。Issue 和 PR 都欢迎。

</div>
