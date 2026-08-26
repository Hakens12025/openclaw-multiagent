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

// §13 多主体真值:整写路径的门。saveGraph 是唯一的整文件覆写入口(快照恢复/测试夹具),
// 此前它绕过 add/delete 端点的 edge 级日志无声覆写——2026-08-26 测试护栏恢复快照把
// 用户测试期手加的边静默抹掉。现在整写前 diff 现图,edge 级差异逐条点名写者
// (与 admin-surface-graph-operations.mutateGraphEdge 的端点日志同格式,单边路径走
// addEdge/removeEdge 不经此处,两处日志不重叠);无差异整写零日志(幂等静默)。
// writer 缺省 "unknown" 是过渡容错:日志照样点名,便于把漏报身份的调用方揪出来。
export async function saveGraph(graph, { writer = "unknown", logger = console } = {}) {
  const writerId = typeof writer === "string" && writer.trim() ? writer.trim() : "unknown";
  await withLock(LOCK_KEY, async () => {
    const current = await loadGraph();
    const nextEdges = normalizeGraphEdges(graph?.edges);
    const currentKeys = new Set(current.edges.map(edgeDiffKey));
    const nextKeys = new Set(nextEdges.map(edgeDiffKey));
    for (const edge of nextEdges) {
      if (!currentKeys.has(edgeDiffKey(edge))) {
        logger?.info?.(`[watchdog] graph edge added: ${edge.from} -> ${edge.to} (writer=${writerId})`);
      }
    }
    for (const edge of current.edges) {
      if (!nextKeys.has(edgeDiffKey(edge))) {
        logger?.info?.(`[watchdog] graph edge removed: ${edge.from} -> ${edge.to} (writer=${writerId})`);
      }
    }
    await writeGraph(graph);
  });
}

export async function pruneGraphToAgentIds(agentIds) {
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
    await writeGraph(graph);
    return graph;
  });
}

export async function removeEdge(from, to) {
  return withLock(LOCK_KEY, async () => {
    const graph = await loadGraph();
    graph.edges = graph.edges.filter(
      (edge) => !(edge.from === from && edge.to === to),
    );
    await writeGraph(graph);
    return graph;
  });
}
