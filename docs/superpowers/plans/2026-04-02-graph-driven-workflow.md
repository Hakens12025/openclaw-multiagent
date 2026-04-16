# Graph-Driven Workflow Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Agent 完成后由 graph 出边决定下一跳，无出边则 delivery 回传。替换现有硬编码 pool dispatch 链路。

**Architecture:** 新增 `graph-router.js` 作为 agent_end 后的统一路由器。它读 graph 出边，根据 gate 类型决定路由策略（default 直通 / round-robin 轮询）。ingress 也改为查 graph 出边。前端流线方向改为查 graph 入边。

**Tech Stack:** Node.js ESM, 复用现有 agent-graph.js 查询函数

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `lib/graph-router.js` | **Create** | agent_end 后的统一路由：查出边 → 选 gate → 分派或 delivery |
| `lib/agent-end-transport.js` | **Modify** | 删除 `enqueueContract` 逻辑，改为调 graph-router |
| `lib/agent-end-terminal.js` | **Modify** | 删除 `shouldKeepContractorWorkerHandoffPending`，由 graph-router 决定是否继续 |
| `lib/ingress-standard-route.js` | **Modify** | 删除 `resolvePlanDispatchTarget`，改为查 graph 出边 |
| `lib/agent-graph.js` | **Modify** | `normalizeEdge` 加 `gate` 和 `capability` 字段 |
| `dashboard.js` | **Modify** | track_start 流线方向改为查 graph 入边 |

---

### Task 1: 扩展 agent-graph.js edge 结构

**Files:**
- Modify: `extensions/watchdog/lib/agent-graph.js`

- [ ] **Step 1: 修改 `normalizeEdge` 函数，加 gate 和 capability 字段**

```javascript
// agent-graph.js, normalizeEdge function (around line 27)
// 在现有 return 对象中加两个字段：
function normalizeEdge(edge) {
  if (!edge || typeof edge !== "object") return null;
  const from = typeof edge.from === "string" ? edge.from.trim() : "";
  const to = typeof edge.to === "string" ? edge.to.trim() : "";
  if (!from || !to) return null;
  return {
    from,
    to,
    label: edge.label || null,
    gate: typeof edge.gate === "string" ? edge.gate.trim() : "default",
    capability: typeof edge.capability === "string" ? edge.capability.trim() : null,
    gates: Array.isArray(edge.gates) ? edge.gates : [],
    metadata: edge.metadata && typeof edge.metadata === "object" && !Array.isArray(edge.metadata)
      ? edge.metadata
      : {},
  };
}
```

- [ ] **Step 2: 新增 `getEdgesFromByGate` 查询函数**

在 `getTransitionsForNode` 之后新增：

```javascript
export function getEdgesFromByGate(graph, nodeId, gate) {
  return getEdgesFrom(graph, nodeId).filter((e) => (e.gate || "default") === gate);
}

export function getEdgesFromByCapability(graph, nodeId, capability) {
  return getEdgesFrom(graph, nodeId).filter((e) => e.capability === capability);
}
```

- [ ] **Step 3: Commit**

```bash
git add extensions/watchdog/lib/agent-graph.js
git commit -m "feat(graph): add gate and capability fields to edge schema"
```

---

### Task 2: 创建 graph-router.js — 核心路由器

**Files:**
- Create: `extensions/watchdog/lib/graph-router.js`

- [ ] **Step 1: 实现 `routeAfterAgentEnd` 函数**

这是整个改动的核心。agent 完成后，watchdog 调用此函数决定下一步。

```javascript
// lib/graph-router.js — Graph-driven post-agent routing

import { loadGraph, getEdgesFrom } from "./agent-graph.js";
import { wakeAgent } from "./comm.js";
import { readCachedContractSnapshotById } from "./contract-store.js";
import { getContractPath } from "./state.js";
import { broadcast } from "./sse.js";

// Round-robin state: agentId → index
const roundRobinIndex = new Map();

/**
 * Agent 完成后，查 graph 出边决定下一跳。
 *
 * @param {string} agentId - 刚完成的 agent
 * @param {string} contractId - 当前合约 ID
 * @param {object} options - { status, api, logger }
 * @returns {{ routed: boolean, action: string, target?: string }}
 */
export async function routeAfterAgentEnd(agentId, contractId, { status, api, logger }) {
  const graph = await loadGraph();
  const outEdges = getEdgesFrom(graph, agentId);

  // 无出边 = 终点 → delivery
  if (outEdges.length === 0) {
    logger.info(`[graph-router] ${agentId} has no out-edges → terminal (delivery)`);
    return { routed: false, action: "terminal" };
  }

  // 单出边 (default gate) → 直接传
  if (outEdges.length === 1) {
    const edge = outEdges[0];
    return await dispatchToTarget(edge.to, contractId, agentId, { api, logger });
  }

  // 多出边 → 按 gate 类型决策
  // 优先检查条件路由 (on-complete / on-fail)
  const conditionalEdges = outEdges.filter(e => e.gate === "on-complete" || e.gate === "on-fail");
  if (conditionalEdges.length > 0) {
    const targetGate = status === "completed" ? "on-complete" : "on-fail";
    const matchedEdge = conditionalEdges.find(e => e.gate === targetGate);
    if (matchedEdge) {
      return await dispatchToTarget(matchedEdge.to, contractId, agentId, { api, logger });
    }
    // 无匹配条件边 → 走 default 边（如果有）
    const defaultEdge = outEdges.find(e => e.gate === "default");
    if (defaultEdge) {
      return await dispatchToTarget(defaultEdge.to, contractId, agentId, { api, logger });
    }
    logger.warn(`[graph-router] ${agentId}: no matching conditional edge for status=${status}`);
    return { routed: false, action: "terminal" };
  }

  // round-robin
  const rrEdges = outEdges.filter(e => e.gate === "round-robin");
  if (rrEdges.length > 0) {
    const idx = (roundRobinIndex.get(agentId) || 0) % rrEdges.length;
    roundRobinIndex.set(agentId, idx + 1);
    const edge = rrEdges[idx];
    return await dispatchToTarget(edge.to, contractId, agentId, { api, logger });
  }

  // fan-out
  const fanOutEdges = outEdges.filter(e => e.gate === "fan-out");
  if (fanOutEdges.length > 0) {
    logger.info(`[graph-router] ${agentId}: fan-out to ${fanOutEdges.length} targets`);
    for (const edge of fanOutEdges) {
      await dispatchToTarget(edge.to, contractId, agentId, { api, logger });
    }
    return { routed: true, action: "fan-out", targets: fanOutEdges.map(e => e.to) };
  }

  // 多出边但无 gate 标注 → 走第一条 default
  const defaultEdge = outEdges.find(e => !e.gate || e.gate === "default");
  if (defaultEdge) {
    return await dispatchToTarget(defaultEdge.to, contractId, agentId, { api, logger });
  }

  logger.warn(`[graph-router] ${agentId}: ${outEdges.length} out-edges but no routing rule matched`);
  return { routed: false, action: "terminal" };
}

/**
 * 把合约分派给目标 agent。
 */
async function dispatchToTarget(targetAgentId, contractId, fromAgentId, { api, logger }) {
  logger.info(`[graph-router] routing ${contractId}: ${fromAgentId} → ${targetAgentId}`);

  // 更新合约 assignee
  try {
    const { updateContractAssignee } = await import("./contracts.js");
    await updateContractAssignee(contractId, targetAgentId, logger);
  } catch (e) {
    logger.warn(`[graph-router] failed to update assignee: ${e.message}`);
  }

  // 路由 inbox
  try {
    const { routeInbox } = await import("../router.js");
    await routeInbox(targetAgentId, logger, { contractId });
  } catch (e) {
    logger.warn(`[graph-router] routeInbox failed: ${e.message}`);
  }

  // 唤醒目标 agent
  const wakeResult = await wakeAgent(
    targetAgentId,
    `执行合约 ${contractId}，请读取 inbox/contract.json 并执行任务，完成后将结果写入合约 output 路径。`,
    api,
    logger,
  );

  broadcast("alert", {
    type: "graph_dispatch",
    from: fromAgentId,
    to: targetAgentId,
    contractId,
    ts: Date.now(),
  });

  return { routed: true, action: "dispatch", target: targetAgentId, wake: wakeResult };
}

/**
 * Ingress 入口：从 bridge/controller 查 graph 出边找第一个下游 agent。
 */
export async function resolveFirstHopFromGraph(sourceAgentId) {
  const graph = await loadGraph();
  const outEdges = getEdgesFrom(graph, sourceAgentId);
  if (outEdges.length === 0) return null;
  // 优先 default gate，否则第一条
  const defaultEdge = outEdges.find(e => !e.gate || e.gate === "default");
  return (defaultEdge || outEdges[0]).to;
}
```

- [ ] **Step 2: Commit**

```bash
git add extensions/watchdog/lib/graph-router.js
git commit -m "feat(graph-router): create graph-driven post-agent routing engine"
```

---

### Task 3: 修改 agent-end-transport.js — 用 graph-router 替代 enqueue

**Files:**
- Modify: `extensions/watchdog/lib/agent-end-transport.js`

- [ ] **Step 1: 替换 enqueueContract 逻辑**

当前 `handleAgentEndTransport` 在 line 38 调用 `enqueueContract` 把 PENDING 合约入 pool。改为调用 `routeAfterAgentEnd`。

关键改动：在 `handleAgentEndTransport` 返回值中加一个 `graphRouteResult` 字段，让 agent-end-pipeline 知道是否已路由。

```javascript
// agent-end-transport.js
import { routeAfterAgentEnd } from "./graph-router.js";

export async function handleAgentEndTransport({
  agentId,
  api,
  logger,
  enqueueContract,  // 保留参数签名兼容，但不再使用
}) {
  const outboxResult = await collectOutbox(agentId, logger);
  let graphRouteResult = null;

  if (outboxResult.collected) {
    logger.info(`[watchdog] collectOutbox(${agentId}): success`);

    if (hasExecutionPolicy(agentId, "planRequired") && outboxResult.contractId) {
      // ... 保留 draft contract 逻辑（forgetDraftContract 等）
      // 但删除 enqueueContract 调用
      // 改为：由 graph-router 在 agent-end-pipeline 的后续阶段处理
    }
  }

  return {
    outboxResult,
    preserveInbox: shouldPreserveRouterInbox(agentId, outboxResult),
    graphRouteResult,
  };
}
```

实际上，更简洁的方案是：**不在 transport 阶段做路由，而是在 agent-end-pipeline 的 `commit_success_terminal` 阶段做**。因为那时才知道 agent 是成功还是失败。

- [ ] **Step 2: 在 agent-end-pipeline.js 的 success terminal 后加 graph routing stage**

在 `AGENT_END_MAIN_STAGES` 数组的 `commit_success_terminal` 之后，加一个新 stage：

```javascript
defineAgentEndStage({
  id: "graph_route",
  match(context) {
    return Boolean(context.trackingState);
  },
  async run(context) {
    const { agentId, logger, api, trackingState, outboxResult } = context;
    const contractId = outboxResult?.contractId
      || trackingState?.contract?.id
      || null;
    if (!contractId) return;

    // 查 graph 出边决定下一跳
    const { routeAfterAgentEnd } = await import("./graph-router.js");
    const routeResult = await routeAfterAgentEnd(agentId, contractId, {
      status: context.event.success ? "completed" : "failed",
      api,
      logger,
    });

    context.graphRouteResult = routeResult;

    // 如果已路由到下一个 agent → 阻止 delivery（不是终点）
    if (routeResult.routed) {
      context.suppressCompletionEgress = true;
    }
  },
}),
```

- [ ] **Step 3: Commit**

```bash
git add extensions/watchdog/lib/agent-end-transport.js extensions/watchdog/lib/agent-end-pipeline.js
git commit -m "feat(agent-end): integrate graph-router for post-agent routing"
```

---

### Task 4: 修改 agent-end-terminal.js — 删除 keepContractPending 硬编码

**Files:**
- Modify: `extensions/watchdog/lib/agent-end-terminal.js`

- [ ] **Step 1: 删除 `shouldKeepContractorWorkerHandoffPending` 函数和调用**

这个函数检查 `planRequired` 策略来决定是否保持合约 pending（等 pool 分派）。现在 graph-router 接管了这个职责。

在 `handleSuccessfulTrackingCompletion` 中（约 line 155-180），删除 `keepContractPending` 分支。所有情况都走 `resolveTerminalOutcome` → `commitSemanticTerminalState` → delivery 或被 graph_route stage 拦截。

```javascript
// 删除这段：
// const keepContractPending = shouldKeepContractorWorkerHandoffPending({...});
// if (keepContractPending) { ... }

// 直接走 resolveTerminalOutcome
const resolvedOutcome = deferredSystemAction
  ? { ... }
  : systemActionFailureOutcome
    ? systemActionFailureOutcome
    : await resolveTerminalOutcome({ trackingState, contractData: effectiveContractForOutcome, outboxResult, logger });
```

- [ ] **Step 2: 在 delivery 触发前检查 context.suppressCompletionEgress**

`handleSuccessfulTrackingCompletion` 目前在 line 242 检查 `suppressCompletionEgress`。确认 graph_route stage 设置的 `context.suppressCompletionEgress` 能传递到这里。

由于 `handleSuccessfulTrackingCompletion` 接收的是 `context` 对象，而 graph_route stage 在它之后运行，所以需要调整顺序：**graph_route stage 应该在 commit_success_terminal 和 commit_failure_terminal 之间，或者 delivery 判定需要延迟到 graph_route 之后**。

最简方案：把 delivery 从 `handleSuccessfulTrackingCompletion` 内部提取出来，作为 agent-end-pipeline 的独立 stage，放在 graph_route 之后。

```javascript
// agent-end-pipeline.js 新 stage 顺序：
// 1. load_tracking_contract
// 2. collect_transport
// 3. consume_system_action
// 4. prepare_tracking_terminal
// 5. commit_success_terminal (只做状态提交，不做 delivery)
// 6. commit_failure_terminal
// 7. graph_route (查出边，设 suppressCompletionEgress)
// 8. completion_egress (如果 !suppressCompletionEgress 才 delivery)
// 9. crash_recovery
```

- [ ] **Step 3: Commit**

```bash
git add extensions/watchdog/lib/agent-end-terminal.js extensions/watchdog/lib/agent-end-pipeline.js
git commit -m "refactor(agent-end): remove keepContractPending, add graph_route + completion_egress stages"
```

---

### Task 5: 修改 ingress-standard-route.js — 查 graph 出边

**Files:**
- Modify: `extensions/watchdog/lib/ingress-standard-route.js`

- [ ] **Step 1: 替换 `resolvePlanDispatchTargetSafe()` 为 `resolveFirstHopFromGraph()`**

```javascript
// ingress-standard-route.js, around line 192-229
// 旧代码：
//   const plannerAgentId = resolvePlanDispatchTargetSafe();
//   if (plannerAgentId) { ... wakeContractor ... }
//   else { enqueue(contractId); }

// 新代码：
import { resolveFirstHopFromGraph } from "./graph-router.js";

const firstHopAgentId = await resolveFirstHopFromGraph(fromAgent);
if (firstHopAgentId) {
  await rememberDraftContract(contractId, { logger });

  // 路由 inbox 到目标 agent
  const { routeInbox } = await import("../router.js");
  await routeInbox(firstHopAgentId, logger, { contractId });

  // 唤醒目标 agent
  const wake = await wakeAgent(
    firstHopAgentId,
    `执行合约 ${contractId}，请读取 inbox/contract.json 并执行任务，完成后将结果写入合约 output 路径。`,
    api,
    logger,
  );

  broadcast("alert", {
    type: "inbox_dispatch",
    contractId,
    task: message.slice(0, 100),
    from: fromAgent,
    assignee: firstHopAgentId,
    ts,
  });

  return { ok: true, contractId, source, targetAgent: firstHopAgentId, wake };
}

// 无出边 → 报错
logger.error(`[ingress] controller ${fromAgent} has no graph out-edges, cannot route`);
return { ok: false, error: "no graph out-edge from controller" };
```

- [ ] **Step 2: 删除 fastTrack / fullPath 区分逻辑**

删除 `simple` 变量的计算、`route: simple ? "short" : "long"` 等所有 fast-track/full-path 残留。

- [ ] **Step 3: Commit**

```bash
git add extensions/watchdog/lib/ingress-standard-route.js
git commit -m "refactor(ingress): replace planner dispatch with graph first-hop resolution"
```

---

### Task 6: 修改 dashboard.js — 前端流线方向修复

**Files:**
- Modify: `extensions/watchdog/dashboard.js`

- [ ] **Step 1: track_start 流线改为查 graph 入边**

```javascript
// dashboard.js, around line 831-835
// 旧代码：
// if (data.replyTo?.agentId) {
//   addActiveFlow(data.replyTo.agentId, data.agentId, truncLabel(data.task), ...);
// }

// 新代码：
if (type === 'track_start') {
  // 从 graph 查谁有出边指向当前 agent → 画那条边的动画
  const graphEdges = window.__graphEdges || [];
  const incomingEdges = graphEdges.filter(e => e.to === data.agentId);
  if (incomingEdges.length > 0) {
    for (const edge of incomingEdges) {
      addActiveFlow(edge.from, data.agentId, truncLabel(data.task), { contractId: data.contractId, type: 'standard' });
    }
  } else if (data.replyTo?.agentId) {
    // fallback: 无 graph 边信息时用 replyTo
    addActiveFlow(data.replyTo.agentId, data.agentId, truncLabel(data.task), { contractId: data.contractId, type: 'standard' });
  }
}
```

需要在 `loadGraph()` 时把 edges 缓存到 `window.__graphEdges`。在 `dashboard-graph.js` 的 `loadGraph` 函数返回后保存：

```javascript
// dashboard-graph.js, loadGraph 函数末尾
window.__graphEdges = graphData.edges || [];
```

- [ ] **Step 2: track_end 流线改为通用（去掉 `startsWith('worker-')` 硬编码）**

```javascript
// dashboard.js, around line 889-901
// 旧代码：
// if (data.agentId?.startsWith('worker-') && data.status !== 'failed') { ... }

// 新代码：查 graph — 如果无出边，说明是终点，显示 delivery 流线
if (type === 'track_end') {
  removeActiveFlowsFor(data.agentId);
  const graphEdges = window.__graphEdges || [];
  const hasOutEdge = graphEdges.some(e => e.from === data.agentId);
  if (!hasOutEdge && data.status !== 'failed') {
    // 终点节点 → 显示 delivery 回传
    const replyTo = data.replyTo?.agentId || 'controller';
    addActiveFlow(data.agentId, replyTo, 'DELIVERY', { type: 'reply' });
    setTimeout(() => removeActiveFlowsFor(replyTo), 5000);  // 5秒显示时间
  }
}
```

- [ ] **Step 3: Commit**

```bash
git add extensions/watchdog/dashboard.js extensions/watchdog/dashboard-graph.js
git commit -m "fix(dashboard): flow lines follow graph edges, delivery line visible 5s"
```

---

### Task 7: 端到端测试验证

**Files:**
- No file changes, only runtime testing

- [ ] **Step 1: 确认 graph 有正确的边**

检查 `agent_graph.json`：

```bash
cat ~/.openclaw/workspaces/controller/agent_graph.json | python3 -c "import sys,json; [print(f'{e[\"from\"]} → {e[\"to\"]} gate={e.get(\"gate\",\"default\")}') for e in json.load(sys.stdin).get('edges',[])]"
```

预期：`controller → planner → worker`（至少这两条边）

- [ ] **Step 2: 运行 single test**

```bash
rm -rf /var/folders/n3/mp3gzlss3rn5gc0qqw1jffm40000gn/T/openclaw-test-locks/global-test-environment
cd ~/.openclaw/extensions/watchdog && node test-runner.js --preset single
```

预期：PASS，时间线显示 controller → planner → worker → delivery

- [ ] **Step 3: 运行 multi test**

```bash
rm -rf /var/folders/n3/mp3gzlss3rn5gc0qqw1jffm40000gn/T/openclaw-test-locks/global-test-environment
node test-runner.js --preset multi
```

预期：3/3 PASS

- [ ] **Step 4: 在前端观察动画**

打开 dashboard，发送测试消息，确认：
- 流线方向跟着 graph 边走（controller→planner→worker）
- 不出现 controller→worker 的直连线
- delivery 回传线显示至少 5 秒

- [ ] **Step 5: Commit + Tag**

```bash
git add -A
git commit -m "feat: graph-driven workflow engine complete"
HTTPS_PROXY=http://127.0.0.1:8080 git push
git tag v64-stable && HTTPS_PROXY=http://127.0.0.1:8080 git push origin v64-stable
```
