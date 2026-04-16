# openclaw-multiagent

> OpenClaw 多 Agent 协作平台
> 目标：把「消息接入 → 任务分流 → 并发执行 → 自动交付」做成可复用、可观测、可测试的工程化工作流。

[![Repo Size](https://img.shields.io/github/repo-size/Hakens12025/openclaw-multiagent)](https://github.com/Hakens12025/openclaw-multiagent)
[![Last Commit](https://img.shields.io/github/last-commit/Hakens12025/openclaw-multiagent)](https://github.com/Hakens12025/openclaw-multiagent/commits/main)

## TL;DR

- 系统入口：WebUI + QQ Bot + A2A / Admin Surfaces。
- 核心能力：Watchdog 编排、并发 worker 池、统一协议（Envelope + Intent + outbox commit）、研究回路、Dashboard、自动化测试套件。
- 设计原则：**LLM 负责内容，代码负责流程**。代码硬路径处理路由/状态机/调度/安全/质量门控，LLM 软路径处理任务理解/代码产出/自然语言回复。
- **新接手？直接看 [`SYSTEM_MAP.md`](SYSTEM_MAP.md) 与 [`CLAUDE.md`](CLAUDE.md)**。

## Architecture

```text
┌─ Gateway Layer ─────────────────────────────────┐
│ openclaw gateway run → openclaw.json → plugins  │
└──────────────────┬──────────────────────────────┘
                   │
┌──────────────────▼──────────────────────────────┐
│ Watchdog Plugin (extensions/watchdog/)           │
│                                                  │
│ Hooks → Ingress classification → Router          │
│          ↓              ↓            ↓           │
│     fast-track    contractor    research-loop    │
│          ↓         (planner)    (researcher →    │
│       executor       ↓          worker-d →       │
│          ↓        executor      evaluator)       │
│       delivery       ↓              ↓            │
│          ↓        delivery      conclude         │
│       bridge                                     │
│          ↓                                       │
│        用户                                      │
└─────────────────────────────────────────────────┘

Agent Roles:
  bridge      — controller, agent-for-kksl (网关桥接)
  planner     — contractor (任务规划)
  executor    — worker / worker2 / worker-3 / worker-4 (通用池)
  researcher  — researcher (研究检索)
  evaluator   — evaluator (评估决策)
```

## 传送带原则（Conveyor Belt）

**绝对禁止在回路里硬编码 agent 名称或角色特化分支。**

传送带是唯一的 transport 原语：
- Agent 只负责：读 inbox → 处理 → 写 outbox → 停止
- 平台只负责：检查 graph 授权 → 排队 → 目标闲时自动投递 → 唤醒
- Graph edge = 授权（谁能投给谁），不是时序控制
- Loop = 传送带重复投递，不是独立协议
- 结果回传走 replyTo 路由元数据，不走 graph

## Repository Layout

```text
.
├── SYSTEM_MAP.md                   # ★ 系统全貌（新接手从这里开始）
├── CLAUDE.md                       # 开发规范 / 项目总纲
├── openclaw.example.json           # 主配置模板（真实密钥需自行填入 openclaw.json）
├── profiles/                       # 部署 profile（端口、地址可覆盖）
│
├── extensions/                     # 源码 — 插件
│   ├── watchdog/                   #   核心编排与监控（lib/ hooks/ routes/ domains/）
│   └── qqbot/                      #   QQ 接入
├── skills/                         # 源码 — 运行时可注入技能
├── scripts/                        # 源码 — 辅助脚本
├── docs/                           # 设计文档
├── wiki/                           # LLM Wiki（概念/决策/索引）
│
├── start.sh                        # 运维 — 一键启动
├── ssh-tunnel.sh                   # 运维 — SSH 隧道
├── setup.sh                        # 运维 — 初始化
└── CODEX.md                        # Codex 执行手册
```

运行态目录（`workspaces/`、`research-lab/`、`test-reports/`、`memory/`、`logs/`、`delivery-queue/` 等）由 Gateway 启动后自动创建，不纳入版本控制。

## Quick Start

### Prerequisites

- macOS（当前维护环境）
- Node.js 22+
- `openclaw` CLI

```bash
npm install -g openclaw
```

### Clone & Configure

```bash
git clone https://github.com/Hakens12025/openclaw-multiagent.git ~/.openclaw
cd ~/.openclaw

# 1. 复制配置模板并填入真实密钥
cp openclaw.example.json openclaw.json
# 编辑 openclaw.json，至少填入：
#   - models.providers.*.apiKey
#   - gateway.auth.token（建议随机生成）
#   - channels.*（可选，需要 QQ/飞书接入时再填）

# 2. 初始化
bash setup.sh
openclaw configure
```

### Run

```bash
# 后台（推荐，含 SSH 隧道）
bash ~/.openclaw/start.sh

# 前台
openclaw gateway run
```

常用地址：

- WebUI: `http://localhost:18789`
- Dashboard: `http://localhost:18789/watchdog/progress?token=<gateway-token>`

## Testing

```bash
cd ~/.openclaw/extensions/watchdog
node test-runner.js --preset single        # 基础链路
node test-runner.js --preset concurrent    # 并发
node test-runner.js --preset research-flow # 研究回路
```

报告输出：`~/.openclaw/test-reports/`（运行态目录，已 gitignore）

## Security Notes

- **`openclaw.json` 必须本地维护，绝不提交仓库**（`.gitignore` 已排除）。
- 本仓库只提供 `openclaw.example.json` 脱敏模板。
- `workspaces/`、`test-reports/`、`research-lab/`、`memory/`、`logs/` 均为运行态目录，不会被追踪。
- 第一次接入 QQ/飞书渠道前，请在对应开放平台拿到 appId/secret，填入本地 `openclaw.json`。

## License

本项目为个人研究用途，默认暂无开源许可证。如需二次分发请先联系作者。
