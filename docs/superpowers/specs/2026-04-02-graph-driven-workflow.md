# Graph-Driven Workflow Engine

## Goal

将 agent 间的任务分派从硬编码链路改为 graph edge 驱动。graph edge 是执行路径的唯一真相源，前端动画和后端路由都从 graph 读取。

## Core Rule

**Agent 完成 → 查 graph 出边 → 路由到下一个 agent。无出边 = 终点 → delivery 回传。**

---

## 1. Edge 结构

扩展现有 `agent_graph.json` 的 edge，新增 `gate` 和 `capability` 字段：

```json
{
  "from": "planner",
  "to": "worker",
  "gate": "default",
  "capability": "execute",
  "label": null,
  "metadata": {}
}
```

### Gate 类型

| Gate | 语义 | 选边规则 |
|------|------|---------|
| `default` | 单条直通 | 唯一出边时自动应用，直接传递 |
| `round-robin` | 轮询分配 | 多条同 gate 的出边之间轮询（现 pool 行为） |
| `fan-out` | 并发 | 复制合约给所有出边目标 |
| `on-complete` | 完成时走 | agent 成功完成后走这条边 |
| `on-fail` | 失败时走 | agent 失败后走这条边 |

### 缺省行为

- 单出边：gate 默认 `default`，不需要标注
- 多出边无 gate 标注：报错，要求用户在前端选择 gate 类型
- capability 可选：agent 可在 outbox 写 `nextCapability` 来匹配特定出边

---

## 2. Agent 完成后的路由逻辑

替换现有的 pool dispatch + 硬编码链路。

```
agent_end
  → collectOutbox（不变）
  → 查 graph: getEdgesFrom(graph, agentId)

  Case 1: 无出边
    → 终点节点，触发 delivery（用合约 replyTo 回传）

  Case 2: 单出边 (gate=default)
    → 把合约传给 edge.to agent
    → 更新合约 assignee = edge.to
    → 唤醒目标 agent

  Case 3: 多出边 + round-robin
    → 在同 gate 的出边中轮询选一个空闲的
    → 传给选中的 agent

  Case 4: 多出边 + fan-out
    → 复制合约给所有出边目标（并发执行）

  Case 5: 多出边 + on-complete / on-fail
    → 根据 agent 完成状态选边
    → 成功 → 走 on-complete 边
    → 失败 → 走 on-fail 边（无 on-fail 边则触发 delivery 报失败）

  Case 6: outbox 含 nextCapability
    → 在出边中找 capability 匹配的边
    → 找到 → 走那条
    → 没找到 → 走 default gate 边
```

---

## 3. 去掉全局 Pool

- 删除 `pool.js` 中的全局 workerPool Map 和 LRU 选择逻辑
- round-robin 行为移入 graph 路由层：当多条出边标记 `gate: "round-robin"` 时，路由器在这些目标间轮询
- `pool.js` 的 `onWorkerDone` / `_dispatchNextInner` 不再是入口，由 graph 路由器统一调度

---

## 4. Ingress 适配

当前 ingress 硬编码了"找 planner → 发合约"。改为：

- ingress 创建合约后，查 graph: `getEdgesFrom(graph, controllerAgentId)`
- 找到出边 → 把合约发给第一个下游 agent
- 无出边 → 报错（controller 必须有出边）

不再调用 `resolvePlanDispatchTarget()`，不再区分 fastTrack / fullPath。

---

## 5. 前端动画修复

### 问题 1: controller→worker 直连线

**原因**: `track_start` 事件用 `replyTo.agentId` 画流线方向。worker 的 replyTo 是 controller，所以画了 controller→worker。

**修复**: `track_start` 流线方向改为查 graph 入边。收到 `track_start(agentId=X)` 时，查 `getEdgesTo(graph, X)` 找到所有指向 X 的边，从这些边的 `from` 节点画流线到 X。

### 问题 2: delivery 回传线几乎看不到

**修复**: delivery 流线增加最小显示时间（比如 3 秒），不要一闪而过。

---

## 6. 不改的部分

- agent SOUL / HEARTBEAT / workspace 结构不变
- 合约结构不变（仍用 inbox/outbox/contract.json）
- SSE 事件结构不变（track_start/progress/end/alert）
- collectOutbox / routeInbox 核心 transport 不变
- agent_graph.json 文件位置和加载方式不变

---

## 7. 实施范围

| 改动 | 优先级 |
|------|--------|
| agent_end 后查 graph 出边路由（替代 pool dispatch） | P0 |
| ingress 查 graph 出边（替代 resolvePlanDispatchTarget） | P0 |
| 无出边 = delivery | P0 |
| 前端 track_start 流线方向改为查 graph | P0 |
| delivery 流线最小显示时间 | P1 |
| gate 类型支持（round-robin / fan-out / on-complete / on-fail） | P1 |
| capability 标签匹配 | P2 |
| 前端编辑 gate 类型的 UI | P2 |
