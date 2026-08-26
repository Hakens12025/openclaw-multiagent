// Graph analysis helpers for platform doc builder.
// Exports: formatAgentIdList, getGraphCollaborationSummary
//
// 2026-08-18 loop 退役:回路【注册表】的渲染(formatLoopNodePath /
// buildRegisteredLoopSection)随机制一并删除。环【检测】保留 —— 图上有环仍是要让
// 人看见的拓扑事实,由下方 detectCycles 一族承担。

import { detectCycles, getEdgesFrom, getEdgesTo } from "../agent/agent-graph.js";
import { normalizeString, uniqueStrings } from "../core/normalize.js";

export function formatAgentIdList(agentIds, {
  emptyLabel = "空",
} = {}) {
  return agentIds.length > 0
    ? agentIds.map((id) => `\`${id}\``).join("、")
    : emptyLabel;
}

function rotateCycleToStart(cycle, agentId) {
  const nodes = uniqueStrings(
    (Array.isArray(cycle) ? cycle : [])
      .map((entry) => normalizeString(entry))
      .filter(Boolean),
  );
  if (nodes.length === 0) return [];
  const startIndex = nodes.indexOf(agentId);
  return startIndex >= 0
    ? [...nodes.slice(startIndex), ...nodes.slice(0, startIndex)]
    : nodes;
}

function getAgentCycleDescriptions(graph, agentId) {
  const descriptions = [];
  const seen = new Set();
  for (const cycle of detectCycles(graph)) {
    if (!Array.isArray(cycle) || !cycle.includes(agentId)) continue;
    const ordered = rotateCycleToStart(cycle, agentId);
    if (ordered.length === 0) continue;
    const closedLoop = [...ordered, ordered[0]];
    const key = closedLoop.join("->");
    if (seen.has(key)) continue;
    seen.add(key);
    descriptions.push(closedLoop.map((id) => `\`${id}\``).join(" → "));
  }
  return descriptions;
}

export function getGraphCollaborationSummary(graph, agentId) {
  return {
    outgoingTargets: uniqueStrings(
      getEdgesFrom(graph, agentId)
        .map((edge) => normalizeString(edge?.to))
        .filter(Boolean),
    ),
    incomingSources: uniqueStrings(
      getEdgesTo(graph, agentId)
        .map((edge) => normalizeString(edge?.from))
        .filter(Boolean),
    ),
    cycles: getAgentCycleDescriptions(graph, agentId),
  };
}
