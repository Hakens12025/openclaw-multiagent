# SYSTEM_MAP.md — 入口与导览

> 零上下文接手从这里开始。所有事实以代码和 `openclaw.json` 为准。
> 全量分层真值在 **[docs/system-map.md](docs/system-map.md)**（11 层 · 板块 · 功能定址，随代码同步），本文只做导览不复刻——复刻必然滞后。

## 1. 系统入口

| 东西 | 位置 |
|---|---|
| 运维唯一入口（init / doctor / start / stop / restart / status / logs） | `node openclawctl.js <命令>`（跨平台：macOS / Linux 原生，Windows 经 WSL2） |
| 网关配置（agent 花名册 / graph / 模型 / 渠道） | `openclaw.json`（由 `node openclawctl.js init` 从 `openclaw.example.json` 生成） |
| 主编排插件 | `extensions/watchdog/`（ingress 分流 · graph 调度 · 合约状态机 · 记录面） |
| 前端（零构建 SPA：指挥台 / 透视 / 管理） | `extensions/watchdog/ui/` → `http://localhost:18789/watchdog/?token=<token>` |
| 记账真值（run_event / trace_event 单表，全局序 + 因果边） | `control-plane/records.db`（代码在 `extensions/watchdog/lib/record-plane/`） |
| 账物对账体检 | `node extensions/watchdog/scripts/record-reconcile.js` |
| 单 run 查账时间线 | `node extensions/watchdog/scripts/run-inspect.js <runId\|contractId\|threadId>` |
| 技能注入 | `skills/` |
| 概念与架构决策 | `wiki/index.md` |
| System Blocks 板块图（改代码先声明 primary System Block，校验 `node scripts/openclaw-block-check.js --primary <block-id>`） | `wiki/concepts/system-blocks.md` + `docs/system-blocks/` |

## 2. 分层速览

11 层全表见 [docs/system-map.md](docs/system-map.md) §2。粗粒度：

```
L0  内核·运行时      gateway 进程 / hook / 会话追踪 / agent_end 生命周期
L1  通讯·传输        传送带派工 / ingress / inbox·outbox / SSE / system-action
L2  协作·编排        graph(投递授权) / 协作授权单源 / contract 状态机
L3  执行·安全沙箱    before/after-tool-call / 执行预算 / [ACTION] 解析
L4  提示词装配       六层装配 / role persona / skill 头
L5  交付·产物        上游产物整包流入 / context 有界注入
L6  知识·RAG         embed / 多知识库 / 召回评测 / rerank
L7  验证·测试        formal-runtime / CheckResult·E-码 / 12 预设
L8  调度·自动化      schedule / automation 轮次驱动
L9  控制面·元层      operator / viz-master / 结构快照回滚 / admin-surface
L10 观测·前端        零构建 SPA(指挥台/透视/管理) / routes HTTP 面
```

## 3. Agent 角色

系统只有 **executor**（干活）与 **controller**（前台分诊/派工）两族；研究、评审、施工等分支只经提示词与工具面区分，不设第三族运行时。渠道消息（WebUI / QQ / 飞书）统一绑定 controller 单前台。

## 4. 主路径一句话

用户消息 → controller 分诊 → 创建 contract（带 assignee/replyTo/上游产物指针）→ 传送带按 graph 授权投递进 assignee inbox → agent 读 inbox、处理、写 outbox、停 → agent_end 采集封包（含实际执行模型观测）→ 按图前送下一跳或 replyTo 回流 → 全程逐事件落 `records.db`。

## 5. 测试入口

```bash
cd extensions/watchdog
node test-runner.js              # health:零 LLM 体检
node test-runner.js --preset single
node test-runner.js --preset full
node test-runner.js --list       # 预设清单以 live 输出为准
```

## 6. 10 分钟接手路径

1. 读 [CLAUDE.md](CLAUDE.md)（硬约束与传送带原则）
2. 读 [docs/system-map.md](docs/system-map.md) §2 板块表（定址真值）
3. 起网关，开前端指挥台，跑一条 `--preset single` 看事件流
4. 用 `run-inspect.js` 对着刚跑完的 run 看账
