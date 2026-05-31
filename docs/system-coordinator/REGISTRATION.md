# system-coordinator — 接入说明

> 这是草案说明片段。编排者/用户确认后再接入 openclaw.json。
> **不要直接修改 openclaw.json**，live 系统动任何 agent 配置前必须人工确认。

---

## 1. openclaw.json agents.list 接入片段

在 `agents.list[]` 末尾追加：

```json
{
  "id": "system-coordinator",
  "role": "agent",
  "workspace": "~/.openclaw/workspaces/system-coordinator",
  "model": {
    "primary": "ark-openai/minimax-m2.5"
  },
  "heartbeat": {
    "every": "4h"
  },
  "skills": [
    "openclaw-system",
    "platform-map",
    "platform-tools",
    "error-avoidance"
  ],
  "tools": {
    "allow": [
      "read",
      "write"
    ],
    "deny": [
      "bash",
      "computer"
    ]
  }
}
```

**说明：**
- `skills` 中 `openclaw-system` 是核心 — 四关节契约与概念预算清单从这里注入（P-B 阶段产出）
- `tools.deny` 拒绝 bash/computer，强制只读+只写 workspace，防止越权执行
- `heartbeat.every` 设 4h：此 agent 是守门人，不需要高频唤醒，由变更通知消息触发为主
- `role: "agent"` — 不是 bridge，不对外暴露通道绑定

---

## 2. 需要的 graph edge（路由授权）

system-coordinator 是**被动消费者**，不主动投递给任何业务 agent，只接收通知并回写结论。

接入时需确认以下方向的投递权限（谁可以发消息给 system-coordinator）：

| 发送方 | 接收方 | 消息类型 | 说明 |
|--------|--------|----------|------|
| `operator` | `system-coordinator` | 协调请求 | operator 改动前请求一致性核查 |
| `controller` | `system-coordinator` | 变更通知 | 系统级变更广播 |
| `system-coordinator` | `operator` | 协调结论 | WARN/BLOCK 时回传风险标记 |
| `system-coordinator` | `controller` | 协调结论 | BLOCK 级别时通知 controller |

具体 graph edge 格式以 openclaw.json 实际 `bindings` / graph 配置为准，接入时对照现有 edge 格式填写。

---

## 3. workspace 路径

```
~/.openclaw/workspaces/system-coordinator/
├── SOUL.md          # agent 身份与状态机
├── HEARTBEAT.md     # 唤醒转发语
├── REGISTRATION.md  # 本文件（接入说明）
├── inbox/           # 接收变更通知 / 协调请求
└── outbox/          # 输出协调结论 (coordination-result-{timestamp}.json)
```

---

## 4. 前置条件

- **P-B `openclaw-system` skill 必须先完成** — 该 agent 的核心领域知识全部来自这个 skill；skill 未就绪时此 agent 无法有效运行
- openclaw.json 接入操作由编排者在 P-B 完成且用户确认后执行

---

## 5. 验证方法（接入后）

向 `inbox/` 投一条测试消息，类型 `coordination-request`，描述一个已知越界场景（如 operator 直写 runtime truth），检查 `outbox/` 是否输出 `riskLevel: "BLOCK"` 结论。
