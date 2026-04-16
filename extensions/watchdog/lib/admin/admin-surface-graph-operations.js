import {
  addEdge,
  composeLoop,
  detectCycles,
  hasDirectedEdge,
  loadGraph,
  removeEdge,
} from "../agent/agent-graph.js";
import { EVENT_TYPE } from "../core/event-types.js";
import {
  composeLoopSpecFromAgents,
  listResolvedGraphLoops,
  resolveGraphLoopSpec,
  upsertGraphLoopSpec,
} from "../loop/graph-loop-registry.js";
import { listResolvedLoopSessions } from "../loop/loop-session-store.js";
import { listAgentRegistry } from "../capability/capability-registry.js";
import { normalizeString } from "../core/normalize.js";
import { resolveLoopTargetId } from "./admin-surface-loop-operations.js";
import { syncAllRuntimeWorkspaceGuidance } from "../workspace-guidance-writer.js";

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
      gates: payload.gates,
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
