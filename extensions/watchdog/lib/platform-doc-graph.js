// Graph analysis helpers for platform doc builder.
// Exports: formatAgentIdList, formatLoopNodePath, buildRegisteredLoopSection,
//          getGraphCollaborationSummary

import { detectCycles, getEdgesFrom, getEdgesTo } from "./agent/agent-graph.js";
import { normalizeString, uniqueStrings } from "./core/normalize.js";

export function formatAgentIdList(agentIds, {
  emptyLabel = "空",
} = {}) {
  return agentIds.length > 0
    ? agentIds.map((id) => `\`${id}\``).join("、")
    : emptyLabel;
}

export function formatLoopNodePath(agentIds) {
  return uniqueStrings(agentIds || [])
    .map((id) => `\`${id}\``)
    .join(" → ");
}

export function buildRegisteredLoopSection(agentId, loops = []) {
  const normalizedAgentId = normalizeString(agentId);
  const resolvedLoops = (Array.isArray(loops) ? loops : [])
    .filter((loop) => loop?.id)
    .slice()
    .sort((left, right) => {
      if ((left?.active === true) !== (right?.active === true)) {
        return left?.active === true ? -1 : 1;
      }
      return String(left?.id || "").localeCompare(String(right?.id || ""));
    });

  if (resolvedLoops.length === 0) {
    return "- loop registry: 空。";
  }

  return resolvedLoops.map((loop) => {
    const nodes = uniqueStrings(loop?.nodes || []);
    const flags = [];
    if (normalizeString(loop?.entryAgentId) === normalizedAgentId) flags.push("你是 entry");
    if (nodes.includes(normalizedAgentId)) flags.push("你在回路中");
    const flagSuffix = flags.length > 0 ? ` | ${flags.join(" | ")}` : "";
    const missingEdges = Array.isArray(loop?.missingEdges) ? loop.missingEdges : [];
    const missingText = missingEdges.length > 0
      ? `; missingEdges=${missingEdges.map((edge) => `\`${edge.from}->${edge.to}\``).join("、")}`
      : "";
    return `- \`${loop.id}\` [${loop?.active === true ? "active" : "inactive"}${flagSuffix}] entry=\`${normalizeString(loop?.entryAgentId) || "unknown"}\`; nodes=${formatLoopNodePath(nodes)}${missingText}`;
  }).join("\n");
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
