# SYSTEM_MAP.md — OpenClaw 单一真相文档

> 零上下文也能 10 分钟接手的入口。所有事实以代码和 `openclaw.json` 为准。

---

## 1. 系统入口

```
用户 ──→ WebUI (localhost:18789)  ──→ controller (bridge)
用户 ──→ QQ Bot (云服务器:18791) ──→ agent-for-kksl (bridge)
用户 ──→ test endpoint            ──→ test (bridge)
```

启动命令：`bash ~/.openclaw/start.sh`（SSH 隧道 + Gateway 一键启动）
手动前台：`openclaw gateway run`

Dashboard：`http://localhost:18789/watchdog/progress?token=<gateway.auth.token>`

---

## 2. 运行时分层

项目维护板块入口：`wiki/concepts/system-blocks.md`。
系统架构看运行时分层；代码更新和 agent 分工先声明 System Block。

```
┌─────────────────────────────────────────────────┐
│  GATEWAY LAYER                                  │
│  openclaw gateway run → 加载 openclaw.json       │
│  注册 plugins: watchdog, qqbot                   │
└────────────────────┬────────────────────────────┘
                     │ hook events
┌────────────────────▼────────────────────────────┐
│  WATCHDOG PLUGIN (extensions/watchdog/)          │
│  ┌──────────┐ ┌──────────┐ ┌──────────────────┐ │
│  │ Hooks    │ │ Routes   │ │ Lib (核心逻辑)     │ │
│  │ ingress  │ │ api      │ │ agent-identity    │ │
│  │ tool-call│ │ dashboard│ │ protocol-prims    │ │
│  │ agent-end│ │ operator │ │ router-handler    │ │
│  │          │ │ a2a      │ │ worker-pool       │ │
│  │          │ │ test-runs│ │ graph / loops     │ │
│  └──────────┘ └──────────┘ └──────────────────┘ │
└────────────────────┬────────────────────────────┘
                     │ inbox/outbox + system_action
┌────────────────────▼────────────────────────────┐
│  AGENT LAYER (各 workspaces/<agentId> 目录)       │
│  每个 agent 有 SOUL.md + HEARTBEAT.md + inbox/    │
│  只通过文件协议通信，不直接调用 watchdog 代码       │
└─────────────────────────────────────────────────┘
```

---

## 3. Agent 角色

| 角色 | Agent ID | 职责 | 特征 |
|------|----------|------|------|
| **bridge** | controller, agent-for-kksl, test | 网关桥接，接收用户消息转发给内部 | gateway=true |
| **planner** | contractor | 复杂任务规划，拆分为 Contract | 读写能力 |
| **executor** | worker-a, worker-b, worker-c | 通用执行池，并发处理 Contract | 可替换 |
| **executor** (specialized) | worker-d | 因子编码专用执行 | specialized=true |
| **researcher** | researcher | 研究检索（web_search/web_fetch） | graph 中的研究节点 |
| **evaluator** | evaluator | 评估决策与质量闸 | 无 web_search |

角色由 `openclaw.json → agents.list[].role` 定义，运行时通过 `agent-identity.js` 解析。
`agent-metadata.js` 提供 legacy fallback 常量（仅当 `runtimeAgentConfigs` 为空时生效）。

---

## 4. 协议对象

### 4.1 信封类型（Envelope）

| 类型 | 含义 | 来源 |
|------|------|------|
| `direct_request` | 用户直接对话 | bridge → executor |
| `execution_contract` | 规划后的执行合同 | planner → executor |
| `workflow_signal` | 系统内部信号 | watchdog → agent |

### 4.2 意图类型（Intent）

`start_loop`, `advance_loop`, `wake_agent`, `create_task` 等。
定义在 `lib/protocol-primitives.js`。

### 4.3 主路径流转

```
用户消息
  → ingress hook
  → bridge → contract → runtime graph → worker-pool → delivery
  → graph-backed loop:
      start_loop(startAgent)
      → graph edge validation
      → loop session / stage context
      → advance_loop(suggestedNext | concluded)
```

### 4.4 outbox 协议

Agent 写 `outbox/` 目录，runtime-mailbox-handler-registry 按 `outboxCommitKinds` 分发：
- `execution_result` — 执行层 agent（planner / worker / researcher / reviewer）统一产出执行结果
- `research_search_space` — researcher 产出研究方向
- `evaluation_verdict` / `evaluation_decision` — evaluator 产出评估结论

---

## 5. Operator 所在层

Operator 是 **watchdog 内部的运行时快照与控制接口**：

| 文件 | 层级 | 功能 |
|------|------|------|
| `lib/operator/operator-context.js` | lib 核心 | 标准化 operator 上下文元数据 |
| `lib/operator/operator-snapshot.js` | lib 核心 | 生成运行时快照（agent 状态、pool、queue） |
| `routes/operator-catalog.js` | HTTP 路由 | `/watchdog/operator-snapshot` API |

**Operator 依赖的已通用层：**
- agent-identity（角色解析）✅
- protocol-primitives（信封/意图标准化）✅
- runtime-mailbox-handler-registry（outbox 路由）✅
- worker-pool（调度）✅

**Operator 仍触及的 legacy/临时层：**
- ingress-classification.js — 启发式分类，非最终协议（见§6）
- agent-metadata.js 的静态 ID 常量 — 仅作 fallback
- dashboard 前端仍有 runtime graph 投影命名残留，真值来自 graph / queue / work item surface

---

## 6. 当前机制 vs Legacy 兼容层

| 机制 | 状态 | 说明 |
|------|------|------|
| `runtimeAgentConfigs`（agent-identity.js） | **当前** | 从 openclaw.json 加载，config-first 角色解析 |
| `agent-metadata.js` 静态常量 | **Legacy 兼容** | 仅当 runtimeAgentConfigs 为空时 fallback |
| `resolveGatewayAgentIdForSource()` legacy 分支 | **Legacy 兼容** | `runtimeAgentConfigs.size === 0` 时才走 |
| `ingress-classification.js` 启发式 | **临时** | `isSimpleTask()` 仍基于正则，非协议层 |
| Dashboard bridge 聚合 | **临时** | 前端仍把多个 bridge 聚合投影到 controller |
| `dashboard.js:9` WORKERS fallback | **临时** | `dynamicWorkers` 覆盖后不再使用，但仍声明 |
| `AGENT_WORKSPACE_OVERRIDES` | **Legacy 兼容** | 被 runtimeAgentConfigs.workspace 覆盖 |

---

## 7. 测试入口

**唯一入口**（禁止手写 curl）：

```bash
cd ~/.openclaw/extensions/watchdog

# 默认 health（零 LLM 系统体检：进程内 + live gateway 检查）
node test-runner.js

# live 链路（按需）
node test-runner.js --preset dispatch       # 最小 live 派工
node test-runner.js --preset pipeline       # 多跳简报→交付物 + 产物包流转
node test-runner.js --preset loop           # 回路 compose→run→预算收敛
node test-runner.js --preset system-action  # [ACTION] 探针三件套
node test-runner.js --preset operator       # operator plan→apply→verify→rollback
node test-runner.js --preset knowledge      # EMBED 门控召回地板
node test-runner.js --preset full           # 7 个 suite 全量串行

# 发现与帮助
node test-runner.js --list
node test-runner.js --help

# 单用例 ad-hoc（仅 dispatch/pipeline 的 case id）
node test-runner.js --case answer-direct
```

旧旗标 `--suite/--filter/--clean` 已退役，会硬报错。
每个检查产出 CheckResult，fail/blocked/skip 必带 `E-*` 错误码（注册表
`extensions/watchdog/lib/formal-runtime/error-codes.js`，hint 指向具体真值文件/路由）。

报告输出：`~/.openclaw/test-reports/devtool-<presetId>-<ts>.txt`（failures-first）+ `.json`（机器可读镜像）

---

## 8. 10 分钟接手路径

1. **本文件** — 系统全貌（3 分钟）
2. **`openclaw.json`** — agent 清单、provider、channel 配置（2 分钟）
3. **`extensions/watchdog/index.js`** — 插件装配入口（2 分钟）
4. **深入按需**：
   - 角色解析 → `lib/agent/agent-identity.js`
   - 协议对象 → `lib/protocol-primitives.js`
   - outbox 路由 → `lib/routing/runtime-mailbox-handler-registry.js`
   - loop runtime → `lib/loop/graph-loop-registry.js` + `lib/loop/loop-round-runtime.js`
   - 前端 → `dashboard.js` + `dashboard-svg.js` + `dashboard-graph.js`
