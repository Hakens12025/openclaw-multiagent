import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import { atomicWriteFile, withLock } from "../state.js";
import { loadGraph, normalizeGraphEdges, resolveAgentGraphFile } from "./agent-graph.js";

const LOCK_KEY = "agent-graph";

// 写侧与读侧共用同一份惰性解析(resolveAgentGraphFile),否则种子只护住一半、
// 读沙箱写生产,比不种更危险。
async function writeGraph(graph) {
  const graphFile = resolveAgentGraphFile();
  await mkdir(dirname(graphFile), { recursive: true });
  await atomicWriteFile(graphFile, JSON.stringify({
    ...graph,
    edges: normalizeGraphEdges(graph?.edges),
  }, null, 2));
}

function normalizeMutableEdge(edge) {
  if (!edge || typeof edge !== "object") return null;
  const from = typeof edge.from === "string" ? edge.from.trim() : "";
  const to = typeof edge.to === "string" ? edge.to.trim() : "";
  if (!from || !to) return null;
  return {
    from,
    to,
    label: edge.label || null,
    metadata: edge.metadata && typeof edge.metadata === "object" && !Array.isArray(edge.metadata)
      ? edge.metadata
      : {},
  };
}

function edgeDiffKey(edge) {
  return `${edge.from}→${edge.to}`;
}

// §13 多主体真值:图写者身份统一在本突变层进门(2026-08-27 归一,此前只有 saveGraph
// 有署名、端点另挂一套无身份日志)。四个写口(saveGraph/pruneGraphToAgentIds/addEdge/
// removeEdge)全部收 writer 并在实际改边时逐条点名,幂等路径静默;调用方(端点/级联/
// 快照恢复/测试夹具)只递身份不再自打 edge 日志——edge 级日志单源=这里。
// writer 缺省 "unknown" 是过渡容错:日志照样点名,便于把漏报身份的调用方揪出来。
function normalizeWriterId(writer) {
  return typeof writer === "string" && writer.trim() ? writer.trim() : "unknown";
}

function logEdgeChange(logger, action, edge, writerId) {
  logger?.info?.(`[watchdog] graph edge ${action}: ${edge.from} -> ${edge.to} (writer=${writerId})`);
}

// saveGraph 是唯一的整文件覆写入口(快照恢复/测试夹具),此前它绕过 edge 级日志无声
// 覆写——2026-08-26 测试护栏恢复快照把用户测试期手加的边静默抹掉。整写前 diff 现图,
// edge 级差异逐条点名写者;无差异整写零日志(幂等静默)。
export async function saveGraph(graph, { writer = "unknown", logger = console } = {}) {
  const writerId = normalizeWriterId(writer);
  await withLock(LOCK_KEY, async () => {
    const current = await loadGraph();
    const nextEdges = normalizeGraphEdges(graph?.edges);
    const currentKeys = new Set(current.edges.map(edgeDiffKey));
    const nextKeys = new Set(nextEdges.map(edgeDiffKey));
    for (const edge of nextEdges) {
      if (!currentKeys.has(edgeDiffKey(edge))) {
        logEdgeChange(logger, "added", edge, writerId);
      }
    }
    for (const edge of current.edges) {
      if (!nextKeys.has(edgeDiffKey(edge))) {
        logEdgeChange(logger, "removed", edge, writerId);
      }
    }
    await writeGraph(graph);
  });
}

// 批量剪边(删 agent 级联):实际剪掉的边逐条署名,零剪静默。
export async function pruneGraphToAgentIds(agentIds, { writer = "unknown", logger = console } = {}) {
  const writerId = normalizeWriterId(writer);
  const validAgentIds = new Set(
    (Array.isArray(agentIds) ? agentIds : [])
      .map((agentId) => typeof agentId === "string" ? agentId.trim() : "")
      .filter(Boolean),
  );

  return withLock(LOCK_KEY, async () => {
    const graph = await loadGraph();
    const removedEdges = [];
    const keptEdges = [];
    for (const edge of graph.edges) {
      if (validAgentIds.has(edge.from) && validAgentIds.has(edge.to)) {
        keptEdges.push(edge);
      } else {
        removedEdges.push(edge);
      }
    }

    if (removedEdges.length === 0) {
      return {
        changed: false,
        graph,
        removedEdges,
      };
    }

    for (const edge of removedEdges) {
      logEdgeChange(logger, "removed", edge, writerId);
    }
    const nextGraph = { ...graph, edges: keptEdges };
    await writeGraph(nextGraph);
    return {
      changed: true,
      graph: nextGraph,
      removedEdges,
    };
  });
}

export async function addEdge(from, to, opts = {}) {
  const writerId = normalizeWriterId(opts.writer);
  const logger = "logger" in opts ? opts.logger : console;
  return withLock(LOCK_KEY, async () => {
    const graph = await loadGraph();
    const nextEdge = normalizeMutableEdge({
      from,
      to,
      label: opts.label,
      metadata: opts.metadata,
    });
    if (!nextEdge) return graph;
    const exists = graph.edges.some((edge) => edge.from === nextEdge.from && edge.to === nextEdge.to);
    if (exists) return graph;
    graph.edges.push(nextEdge);
    logEdgeChange(logger, "added", nextEdge, writerId);
    await writeGraph(graph);
    return graph;
  });
}

export async function removeEdge(from, to, { writer = "unknown", logger = console } = {}) {
  const writerId = normalizeWriterId(writer);
  return withLock(LOCK_KEY, async () => {
    const graph = await loadGraph();
    const kept = graph.edges.filter(
      (edge) => !(edge.from === from && edge.to === to),
    );
    if (kept.length !== graph.edges.length) {
      logEdgeChange(logger, "removed", { from, to }, writerId);
    }
    graph.edges = kept;
    await writeGraph(graph);
    return graph;
  });
}
