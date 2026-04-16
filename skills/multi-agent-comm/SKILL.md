---
name: multi-agent-comm
description: 多 Agent 系统通信指南。指导 AI 如何在多 agent 场景中选择正确的通信方式、避免上下文污染、实现跨 agent 协作。
metadata: {"clawdbot":{"emoji":"🔗","requires":{"tools":["agentToAgent","sessions"]}}}
---

# 多 Agent 通信指南

在多 agent 协作中，选择正确的通信方式是关键。核心原则：**避免上下文污染**（agent 间只传摘要，不传历史）。

---

## 通信方式速查

### 1. A2A `sessions_send`（平级 agent 间通信）

**适用场景**：Controller 分配任务给 Worker、Worker 回传结果、Supervisor 审核
**上下文污染**：低（摘要注入）
**协议**：ping-pong，0-5 轮

```
使用 sessions_send 向 agent "{target_agent_id}" 发送消息：
- 只发送任务摘要或结果摘要
- 不要转发完整对话历史
- 控制轮数（通常 1-2 轮足够）
```

**何时用**：
- Controller 给 Worker 分配任务
- Worker 把执行结果发回 Controller
- Watchdog 向主 agent 询问状态
- Supervisor 对 Worker 发反馈

### 2. Subagent spawn + announce（临时子任务）

**适用场景**：耗时子任务、需要干净上下文的专注任务、并行子任务
**上下文污染**：低（只有 announce 结果进入父 agent 上下文）

```
spawn subagent 时：
- 给 subagent 清晰的单一任务描述
- subagent 有独立 session key（agent:<id>:subagent:<uuid>）
- 完成后结果通过 announce 回传
- subagent 自动销毁，不保留状态
```

**何时用**：
- 任务可独立执行，不需要父 agent 的对话历史
- 需要并行处理多个子任务
- 想保持父 agent 上下文干净

### 3. Plugin Hook（旁路监控，LLM 上下文外）

**适用场景**：监控、日志、计时、触发外部动作
**上下文污染**：无（完全在 LLM 上下文之外运行）

可用事件：
- `before_agent_start` — agent 每轮 LLM 开始前
- `agent_end` — agent 每轮 LLM 结束后
- `session_start` / `session_end` — session 生命周期
- `message_received` / `message_sending` — 消息收发
- `before_tool_call` / `after_tool_call` — 工具调用前后

**何时用**：
- Watchdog 超时监控（before_agent_start 启动计时器，agent_end 清除）
- 记录 agent 执行时间和 token 消耗
- 触发外部 webhook 通知

### 4. Hook Mapping → Agent（webhook 唤醒 agent）

**适用场景**：外部事件触发 agent 执行（如超时告警、定时任务）
**上下文污染**：低（仅注入 messageTemplate 内容）

```jsonc
// openclaw.json 中配置
{
  "hooks": {
    "mappings": [{
      "id": "watchdog-timeout",
      "match": { "path": "/hooks/watchdog-timeout" },
      "action": "agent",
      "agentId": "watchdog-timeout",
      "sessionKey": "hook:watchdog-timeout",
      "messageTemplate": "{{message}}"
    }]
  }
}
```

**何时用**：
- Plugin 超时后唤醒 watchdog agent
- 外部系统通过 HTTP 触发 agent 任务
- 定时事件驱动 agent 执行

### 5. Internal Hook（跨 plugin 事件广播）

**适用场景**：plugin 间协调、诊断遥测
**上下文污染**：无

```typescript
api.triggerInternalHook('custom-event', { data: '...' });
api.registerHook(['session', 'agent'], handler);
```

**何时用**：
- Memory plugin 监听 session_end 自动存档
- 多个 plugin 需要协调（如日志 + 监控）

### 6. Session Access Policy（可见性控制）

策略级别：`self` → `tree` → `agent` → `all`

- `self`：只能看自己的 session
- `tree`：能看自己和 subagent 的 session
- `agent`：能看同 agent ID 的所有 session
- `all`：能看所有 agent 的 session（适合 watchdog）

---

## 场景决策树

```
需要通信？
  │
  ├─ agent → agent（平级）
  │   └─ 用 A2A sessions_send（只传摘要）
  │
  ├─ agent → 子任务（需要干净上下文）
  │   └─ spawn subagent（用完即毁）
  │
  ├─ 监控/日志（不能污染 LLM 上下文）
  │   └─ Plugin Hook（旁路运行）
  │
  ├─ 外部事件 → 唤醒 agent
  │   └─ Hook Mapping（webhook → agent）
  │
  └─ 反馈回路（不满意 → 重做）
      └─ Controller 通过 A2A 重新发消息给 Worker
```

---

## 关键原则

1. **Workers 之间不直接通信** — 所有跨 Worker 协调经过 Controller
2. **只传摘要，不传历史** — sessions_send 发结果，不发对话记录
3. **监控不污染** — 用 Plugin Hook，不用消息注入
4. **反馈单一入口** — 通过 Controller 注入（可控、可追踪）
5. **Subagent 用完即毁** — 不保留状态，不复用 session

---

## 多 Watchdog 架构

不同监控方向用不同 agent，各有独立 session 和 prompt：

| Watchdog | 职责 | 触发方式 |
|----------|------|---------|
| `watchdog-timeout` | 超时监控 | Plugin Hook setTimeout → webhook |
| `watchdog-quality` | 结果质量审查 | agent_end hook 检查输出 |
| `watchdog-cost` | token/API 消耗 | after_tool_call hook 累计统计 |

超时监控流程：
```
主 agent 开始 → before_agent_start → plugin 启动 setTimeout
主 agent 结束 → agent_end → plugin 清除 timer
超时未结束 → plugin POST webhook → hook mapping → watchdog-timeout agent 被唤醒
watchdog-timeout → sessions_send 向主 agent 询问状态
```
