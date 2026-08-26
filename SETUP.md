# OpenClaw Multi-Agent System — Setup Guide

在一台新机器上复现整套系统。架构与机制介绍见 [README.md](README.md) 与 [SYSTEM_MAP.md](SYSTEM_MAP.md)，本文只管装起来、跑起来、验起来。

## Prerequisites

- **macOS**（日常在 Darwin 25.x / Mac mini 上跑）
- **Node.js v22+**（建议经 nvm）
- **Git**
- （可选）QQ 接入需要一台可 SSH 的云服务器做隧道

## Step-by-Step

### 1. 安装 OpenClaw CLI

```bash
# 没有 nvm 先装 nvm
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
nvm install 22 && nvm use 22

npm install -g openclaw
openclaw --version
```

### 2. 克隆本仓库

```bash
git clone https://github.com/Hakens12025/openclaw-multiagent.git ~/.openclaw
cd ~/.openclaw
```

### 3. 配置

```bash
cp openclaw.example.json openclaw.json
```

编辑 `openclaw.json`：

- `models.providers.*.apiKey` —— 填你的模型 API key（Kimi / GLM / OpenAI 兼容 / 本地 Ollama 任选，`agents.defaults.model.primary` 指定主力，失联自动走 fallbacks）
- `gateway.auth.token` —— 自定一个访问 token（前端与 API 鉴权用）
- `agents.list` —— agent 花名册（默认带 controller / planner / worker / worker2 / operator / viz-master，可增删）
- `channels` —— 需要 QQ / 飞书接入才填，纯 WebUI 可留空

`openclaw.json` 含密钥，**严禁提交进任何公开仓**。

### 4. 初始化与启动

```bash
bash setup.sh    # 建 workspace 目录等一次性初始化
bash start.sh    # 起 SSH 隧道(如配置)与 Gateway
```

QQ 接入才需要额外两步：`extensions/qqbot` 里 `npm install`，以及配好 `scripts/ssh-tunnel-service.sh` 指向你的云服务器。

### 5. 验证

1. 前端：`http://localhost:18789/watchdog/?token=<你的 token>`（指挥台 / 透视 / 管理）
2. 零 LLM 体检：`cd extensions/watchdog && node test-runner.js`（默认 health 预设，不花 token）
3. 最小 live 链路：`node test-runner.js --preset single` —— 注入一条极简派工，观察 合约创建 → 传送带投递 → agent 执行 → 产物回流 全链路，报告落 `~/.openclaw/test-reports/`
4. 前端指挥台应能看到刚才这条 run 的实时事件流；透视页可下钻到合约时间线与会话转录

### 6. 日常运维

```bash
# 重启网关（唯一正道；不要 pkill + 手工 nohup，会撞出双网关）
bash scripts/clean-restart-gateway.sh

# 账物对账体检（记账真值 records.db vs 树内文件）
node extensions/watchdog/scripts/record-reconcile.js

# 查一条 run 的完整时间线
node extensions/watchdog/scripts/run-inspect.js <runId|contractId|threadId>
```

日志在 `~/.openclaw/logs/gateway.log`（stderr 在 `gateway.err.log`）。

## 目录速览

```
~/.openclaw/
├── openclaw.json            # 主配置(agent/模型/渠道/插件) —— 含密钥,勿公开
├── extensions/
│   ├── watchdog/            # 主编排插件:lib/(分层模块) + ui/(零构建 SPA) + tests/
│   └── qqbot/               # QQ 渠道插件
├── control-plane/           # 运行时真值:records.db(记账) + threads/(树内正本与产物)
├── workspaces/              # 各 agent 工作区(inbox/outbox 文件协议)
├── skills/                  # 运行时可注入技能
├── wiki/                    # 概念与架构决策(LLM 维护)
├── docs/                    # system-map 等系统文档
└── scripts/                 # 运维脚本(重启/对账/公开仓同步等)
```

## Troubleshooting

**网关起不来 / 行为怪** —— 先 `bash scripts/clean-restart-gateway.sh`（它带野进程护栏）；看 `~/.openclaw/logs/gateway.err.log`。不要 `pkill -9 -f openclaw`：按命令行匹配会误杀路径含 `.openclaw` 的无关进程。

**agent 不接活** —— 透视页看该合约时间线卡在哪个事件；`workspaces/<agent>/inbox/` 里有没有 `contract.json`；`openclaw.json` 里 graph 有没有授权这条投递边。

**测试红了** —— 读 `~/.openclaw/test-reports/` 里最新报告（failures-first，每条失败带 `E-*` 错误码），不要先 tail 全量日志。

**改了 watchdog 代码不生效** —— 插件代码在网关进程内跑，改完必须重启网关（config 热载不覆盖插件代码）。
