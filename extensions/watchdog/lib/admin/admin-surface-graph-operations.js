import {
  detectCycles,
  hasDirectedEdge,
  loadGraph,
} from "../agent/agent-graph.js";
import {
  addEdge,
  composeLoop,
  removeEdge,
} from "../agent/agent-graph-mutations.js";
import { EVENT_TYPE } from "../core/event-types.js";
import {
  composeLoopSpecFromAgents,
  listResolvedGraphLoops,
  removeGraphLoopSpec,
  resolveGraphLoopSpec,
  upsertGraphLoopSpec,
} from "../loop/graph-loop-registry.js";
import { listResolvedLoopSessions } from "../loop/loop-session-store.js";
import { expandAgentGroup } from "../agent/agent-group-spec.js";
import { startGroupSession } from "../agent/group-session-store.js";
import { listAgentRegistry } from "../capability/capability-registry.js";
import { normalizeString } from "../core/normalize.js";
import { syncAllRuntimeWorkspaceGuidance } from "../workspace-guidance-writer.js";
import { resolveLoopTargetId } from "./admin-surface-loop-operations.js";

function parseOrderedAgentIds(value) {
  const values = Array.isArray(value)
    ? value
    : (typeof value === "string" ? value.split(/[\n,]+/g) : []);
  return values
    .map((item) => normalizeString(item))
    .filter(Boolean);
}

function resolveLoopRepairTarget({
  requestedLoopId,
  loops,
  loopSessions,
}) {
  if (requestedLoopId) {
    return (Array.isArray(loops) ? loops : []).find((loop) => loop?.id === requestedLoopId) || null;
  }

  const activeBrokenSession = (Array.isArray(loopSessions) ? loopSessions : [])
    .find((session) => session?.active === true && session?.runtimeStatus === "broken");
  if (activeBrokenSession?.loopId) {
    return (Array.isArray(loops) ? loops : []).find((loop) => loop?.id === activeBrokenSession.loopId) || null;
  }

  const brokenLoops = (Array.isArray(loops) ? loops : [])
    .filter((loop) => Array.isArray(loop?.missingEdges) && loop.missingEdges.length > 0);
  if (brokenLoops.length === 1) {
    return brokenLoops[0];
  }

  if ((Array.isArray(loops) ? loops.length : 0) === 1) {
    return loops[0];
  }

  return null;
}

export async function mutateGraphEdge({
  mode,
  payload,
  logger,
  onAlert,
  runtimeContext,
}) {
  const from = normalizeString(payload.from);
  const to = normalizeString(payload.to);
  if (!from || !to) {
    throw new Error("missing from or to");
  }

  const existingGraph = await loadGraph();
  const edgeExists = hasDirectedEdge(existingGraph, from, to);
  const existingLoops = await listResolvedGraphLoops({ graph: existingGraph });

  if (mode === "add" && edgeExists) {
    return {
      ok: true,
      skipped: true,
      reason: "edge_exists",
      from,
      to,
      graph: existingGraph,
      loops: existingLoops,
      cycles: detectCycles(existingGraph),
    };
  }

  if (mode === "delete" && !edgeExists) {
    return {
      ok: true,
      skipped: true,
      reason: "edge_missing",
      from,
      to,
      graph: existingGraph,
      loops: existingLoops,
      cycles: detectCycles(existingGraph),
    };
  }

  const graph = mode === "add"
    ? await addEdge(from, to, {
      label: payload.label,
      metadata: payload.metadata,
    })
    : await removeEdge(from, to);
  const cycles = detectCycles(graph);
  const loops = await listResolvedGraphLoops({ graph });
  if (runtimeContext?.api?.config) {
    await syncAllRuntimeWorkspaceGuidance(runtimeContext.api.config, logger);
  }
  logger?.info?.(`[watchdog] graph edge ${mode === "add" ? "added" : "removed"}: ${from} -> ${to}`);
  onAlert?.({
    type: EVENT_TYPE.GRAPH_UPDATED,
    action: mode === "add" ? "edge_added" : "edge_removed",
    from,
    to,
    loops,
    cycles,
    ts: Date.now(),
  });
  return {
    ok: true,
    from,
    to,
    graph,
    loops,
    cycles,
  };
}

export async function composeGraphLoop({
  payload,
  logger,
  onAlert,
  runtimeContext,
}) {
  const requestedAgents = parseOrderedAgentIds(payload.agents ?? payload.agentsText);
  const agentIds = [...requestedAgents];
  if (agentIds.length >= 3 && agentIds[0] === agentIds[agentIds.length - 1]) {
    agentIds.pop();
  }
  if (agentIds.length < 2) {
    throw new Error("loop requires at least 2 agents");
  }

  const seen = new Set();
  const duplicates = [];
  for (const agentId of agentIds) {
    if (seen.has(agentId)) {
      duplicates.push(agentId);
      continue;
    }
    seen.add(agentId);
  }
  if (duplicates.length > 0) {
    throw new Error(`loop contains duplicate agent ids: ${duplicates.join(", ")}`);
  }

  const registry = await listAgentRegistry();
  const knownAgentIds = new Set(
    registry
      .map((agent) => normalizeString(agent?.id))
      .filter(Boolean),
  );
  const missingAgentIds = agentIds.filter((agentId) => !knownAgentIds.has(agentId));
  if (missingAgentIds.length > 0) {
    throw new Error(`unknown agent ids: ${missingAgentIds.join(", ")}`);
  }

  const { graph, loopEdges, addedEdges, skippedEdges } = await composeLoop(agentIds, {
    label: payload.label,
    metadata: payload.metadata,
  });
  const loopSpec = await upsertGraphLoopSpec(composeLoopSpecFromAgents(agentIds, {
    loopId: payload.loopId,
    label: payload.label,
    entryAgentId: payload.entryAgentId,
    continueSignal: payload.continueSignal,
    concludeSignal: payload.concludeSignal,
    maxRounds: payload.maxRounds,
    maxExperiments: payload.maxExperiments,
    metadata: {
      ...(payload.metadata && typeof payload.metadata === "object" ? payload.metadata : {}),
      sourceSurfaceId: "graph.loop.compose",
    },
  }));
  const cycles = detectCycles(graph);
  const resolvedLoop = resolveGraphLoopSpec(loopSpec, graph);
  const loops = await listResolvedGraphLoops({ graph });
  if (runtimeContext?.api?.config) {
    await syncAllRuntimeWorkspaceGuidance(runtimeContext.api.config, logger);
  }
  logger?.info?.(`[watchdog] graph loop composed: ${agentIds.join(" -> ")} -> ${agentIds[0]}`);
  onAlert?.({
    type: EVENT_TYPE.GRAPH_UPDATED,
    action: "loop_composed",
    agents: agentIds,
    loopId: resolvedLoop?.id || loopSpec.id,
    loopEdges,
    addedEdges,
    skippedEdges,
    loops,
    cycles,
    ts: Date.now(),
  });
  return {
    ok: true,
    agents: agentIds,
    loop: resolvedLoop,
    loopEdges,
    addedEdges,
    skippedEdges,
    graph,
    loops,
    cycles,
  };
}

// AgentGroup 宏装配（备忘录 85/86）：把一组 agent 的内部协作展开成
//   ① 显式 EdgeSpec（带 metadata.groupId，平等进 graph，走既有授权链路）
//   ② GroupSession（运行层种子，持久到 group-session-store，与 graph/loop 正交）
//   ③ outputPolicies（binding 层投影；aggregateGroup 当前为 reserved/未被聚合 handler 消费，
//      故 v1 只返回不写 binding——避免动 openclaw.json 换取零运行时收益；聚合 handler 落地时再接）。
// 镜像 composeGraphLoop 的校验/装配模式。group 与 loop 可共享成员（space×time 正交）。
export async function composeGraphGroup({
  payload,
  logger,
  onAlert,
  runtimeContext,
}) {
  const members = parseOrderedAgentIds(payload.agents ?? payload.agentsText ?? payload.members);
  if (members.length < 2) {
    throw new Error("agent group requires at least 2 members");
  }

  const seen = new Set();
  const duplicates = [];
  for (const member of members) {
    if (seen.has(member)) {
      duplicates.push(member);
      continue;
    }
    seen.add(member);
  }
  if (duplicates.length > 0) {
    throw new Error(`agent group contains duplicate member ids: ${duplicates.join(", ")}`);
  }

  const registry = await listAgentRegistry();
  const knownAgentIds = new Set(
    registry.map((agent) => normalizeString(agent?.id)).filter(Boolean),
  );
  const missingAgentIds = members.filter((agentId) => !knownAgentIds.has(agentId));
  if (missingAgentIds.length > 0) {
    throw new Error(`unknown agent ids: ${missingAgentIds.join(", ")}`);
  }

  const groupId = normalizeString(payload.groupId) || `group-${members.join("-")}`;
  // 宏展开（纯函数）。normalizeGroupSpec 已保证组内边两端必须是成员（红线：不开免授权暗门）。
  const expanded = expandAgentGroup({
    id: groupId,
    members,
    entry: payload.entry,
    internalEdges: payload.internalEdges,
    outputMode: payload.outputMode,
    metadata: {
      ...(payload.metadata && typeof payload.metadata === "object" ? payload.metadata : {}),
      sourceSurfaceId: "graph.group.compose",
      ...(normalizeString(payload.label) ? { label: normalizeString(payload.label) } : {}),
    },
  });
  if (!expanded.groupSession) {
    throw new Error("invalid agent group spec (need id + >=2 members + valid outputMode)");
  }

  // 内部边平等进 graph（带 metadata.groupId），走既有 addEdge 授权/去重；空 internalEdges 合法（纯聚合组）。
  const beforeGraph = await loadGraph();
  const addedEdges = [];
  const skippedEdges = [];
  for (const edge of expanded.edges) {
    const exists = beforeGraph.edges.some((item) => item.from === edge.from && item.to === edge.to);
    if (exists) {
      skippedEdges.push({ from: edge.from, to: edge.to });
      continue;
    }
    await addEdge(edge.from, edge.to, { label: edge.label || null, metadata: edge.metadata });
    addedEdges.push({ from: edge.from, to: edge.to });
  }

  // GroupSession 运行层种子（research-lab，不碰 config）。spec/session 分开。
  const groupSession = await startGroupSession({
    groupId: expanded.groupSession.groupId,
    members: expanded.groupSession.members,
    entryAgentId: expanded.groupSession.entryAgentId,
    outputMode: expanded.groupSession.outputMode,
    metadata: expanded.groupSession.metadata,
  });

  const graph = await loadGraph();
  const cycles = detectCycles(graph);
  if (runtimeContext?.api?.config) {
    await syncAllRuntimeWorkspaceGuidance(runtimeContext.api.config, logger);
  }
  logger?.info?.(
    `[watchdog] agent group composed: ${groupId} [${members.join(", ")}] outputMode=${expanded.groupSession.outputMode}`,
  );
  onAlert?.({
    type: EVENT_TYPE.GRAPH_UPDATED,
    action: "group_composed",
    groupId,
    members,
    addedEdges,
    skippedEdges,
    outputMode: expanded.groupSession.outputMode,
    ts: Date.now(),
  });

  return {
    ok: true,
    groupId,
    members,
    entryAgentId: expanded.groupSession.entryAgentId,
    outputMode: expanded.groupSession.outputMode,
    addedEdges,
    skippedEdges,
    outputPolicies: expanded.outputPolicies,
    groupSession,
    cycles,
  };
}

export async function deleteGraphLoop({
  payload,
  logger,
  onAlert,
  runtimeContext,
}) {
  const loopId = normalizeString(payload.loopId);
  if (!loopId) {
    throw new Error("graph.loop.delete requires loopId");
  }
  // De-register the LoopSpec (it is no longer a driven loop). Authorization edges remain —
  // remove them separately via graph.edge.delete if desired. Reversible by graph.loop.compose.
  const result = await removeGraphLoopSpec(loopId);
  const graph = await loadGraph();
  const loops = await listResolvedGraphLoops({ graph });
  const cycles = detectCycles(graph);
  if (result.removed === 0) {
    return { ok: false, error: `loop not found: ${loopId}`, loopId, loops, cycles };
  }
  if (runtimeContext?.api?.config) {
    await syncAllRuntimeWorkspaceGuidance(runtimeContext.api.config, logger);
  }
  logger?.info?.(`[watchdog] graph loop deleted: ${loopId}`);
  onAlert?.({
    type: EVENT_TYPE.GRAPH_UPDATED,
    action: "loop_deleted",
    loopId,
    loops,
    cycles,
    ts: Date.now(),
  });
  return { ok: true, loopId, removed: result.removed, loops, cycles, graph };
}

export async function repairGraphLoop({
  payload,
  logger,
  onAlert,
  runtimeContext,
}) {
  let graph = await loadGraph();
  const existingLoops = await listResolvedGraphLoops({ graph });
  const existingLoopSessions = await listResolvedLoopSessions({ loops: existingLoops });
  const requestedLoopId = resolveLoopTargetId(payload);
  const targetLoop = resolveLoopRepairTarget({
    requestedLoopId,
    loops: existingLoops,
    loopSessions: existingLoopSessions,
  });

  if (!targetLoop) {
    throw new Error(requestedLoopId
      ? `unknown loop id: ${requestedLoopId}`
      : "could not resolve a single loop to repair");
  }

  const missingEdges = Array.isArray(targetLoop.missingEdges) ? targetLoop.missingEdges : [];
  if (missingEdges.length === 0) {
    return {
      ok: true,
      skipped: true,
      reason: "loop_already_healthy",
      loop: targetLoop,
      graph,
      loops: existingLoops,
      cycles: detectCycles(graph),
    };
  }

  const addedEdges = [];
  const skippedEdges = [];
  for (const edge of missingEdges) {
    const from = normalizeString(edge?.from);
    const to = normalizeString(edge?.to);
    if (!from || !to) continue;
    if (hasDirectedEdge(graph, from, to)) {
      skippedEdges.push({ from, to });
      continue;
    }
    graph = await addEdge(from, to, {
      label: edge?.label || targetLoop.label || payload.label,
      metadata: {
        loopId: targetLoop.id,
        repairedBySurface: "graph.loop.repair",
      },
    });
    addedEdges.push({ from, to });
  }

  const cycles = detectCycles(graph);
  const loops = await listResolvedGraphLoops({ graph });
  const repairedLoop = loops.find((loop) => loop?.id === targetLoop.id) || targetLoop;
  const loopSessions = await listResolvedLoopSessions({ loops });
  const activeSession = loopSessions.find((session) => session?.active === true && session?.loopId === repairedLoop.id) || null;
  if (runtimeContext?.api?.config) {
    await syncAllRuntimeWorkspaceGuidance(runtimeContext.api.config, logger);
  }
  logger?.info?.(`[watchdog] graph loop repaired: ${repairedLoop.id} (+${addedEdges.length} edges)`);
  onAlert?.({
    type: EVENT_TYPE.GRAPH_UPDATED,
    action: "loop_repaired",
    loopId: repairedLoop.id,
    addedEdges,
    skippedEdges,
    loops,
    cycles,
    ts: Date.now(),
  });
  return {
    ok: true,
    loop: repairedLoop,
    addedEdges,
    skippedEdges,
    repairedSessionId: activeSession?.id || null,
    graph,
    loops,
    cycles,
  };
}
