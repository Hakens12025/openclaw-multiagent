import {
  detectCycles,
  hasDirectedEdge,
  loadGraph,
} from "../../agent/agent-graph.js";
import {
  addEdge,
  removeEdge,
} from "../../agent/agent-graph-mutations.js";
import { EVENT_TYPE } from "../../core/event-types.js";
import { expandAgentGroup } from "../../agent/agent-group-spec.js";
import { startGroupSession } from "../../agent/group-session-store.js";
import { listAgentRegistry } from "../../management/capability-registry.js";
import { normalizeString } from "../../core/normalize.js";
import { syncAllRuntimeWorkspaceGuidance } from "../../workspace-guidance-writer.js";

function parseOrderedAgentIds(value) {
  const values = Array.isArray(value)
    ? value
    : (typeof value === "string" ? value.split(/[\n,]+/g) : []);
  return values
    .map((item) => normalizeString(item))
    .filter(Boolean);
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

  if (mode === "add" && edgeExists) {
    return {
      ok: true,
      skipped: true,
      reason: "edge_exists",
      from,
      to,
      graph: existingGraph,
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
  if (runtimeContext?.api?.config) {
    await syncAllRuntimeWorkspaceGuidance(runtimeContext.api.config, logger);
  }
  logger?.info?.(`[watchdog] graph edge ${mode === "add" ? "added" : "removed"}: ${from} -> ${to}`);
  onAlert?.({
    type: EVENT_TYPE.GRAPH_UPDATED,
    action: mode === "add" ? "edge_added" : "edge_removed",
    from,
    to,
    cycles,
    ts: Date.now(),
  });
  return {
    ok: true,
    from,
    to,
    graph,
    cycles,
  };
}

// AgentGroup 宏装配（备忘录 85/86）：把一组 agent 的内部协作展开成
//   ① 显式 EdgeSpec（带 metadata.groupId，平等进 graph，走既有授权链路）
//   ② GroupSession（运行层种子，持久到 group-session-store，与 graph 正交）
//   ③ outputPolicies（binding 层投影；aggregateGroup 当前为 reserved/未被聚合 handler 消费，
//      故 v1 只返回不写 binding——避免动 openclaw.json 换取零运行时收益；聚合 handler 落地时再接）。
// 校验/装配沿用 mutateGraphEdge 的同一套 registry 校验 + addEdge 去重路径。
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
