import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import { atomicWriteFile, withLock } from "../state.js";
import { loadGraph, normalizeGraphEdges } from "./agent-graph.js";
import { CONTROL_PLANE_PATHS } from "../control-plane/control-plane-paths.js";

const GRAPH_FILE = CONTROL_PLANE_PATHS.agentGraphFile;
const LOCK_KEY = "agent-graph";

async function writeGraph(graph) {
  await mkdir(dirname(GRAPH_FILE), { recursive: true });
  await atomicWriteFile(GRAPH_FILE, JSON.stringify({
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

export async function saveGraph(graph) {
  await withLock(LOCK_KEY, async () => {
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

export async function composeLoop(agentIds, opts = {}) {
  return withLock(LOCK_KEY, async () => {
    const orderedAgentIds = Array.isArray(agentIds) ? agentIds.filter(Boolean) : [];
    const loopEdges = [];
    for (let index = 0; index < orderedAgentIds.length; index += 1) {
      loopEdges.push({
        from: orderedAgentIds[index],
        to: orderedAgentIds[(index + 1) % orderedAgentIds.length],
        label: opts.label || null,
        metadata: opts.metadata && typeof opts.metadata === "object" ? opts.metadata : {},
      });
    }

    const graph = await loadGraph();
    const addedEdges = [];
    const skippedEdges = [];

    for (const edge of loopEdges) {
      const exists = graph.edges.some((item) => item.from === edge.from && item.to === edge.to);
      if (exists) {
        skippedEdges.push({
          from: edge.from,
          to: edge.to,
        });
        continue;
      }
      graph.edges.push(edge);
      addedEdges.push({
        from: edge.from,
        to: edge.to,
        label: edge.label,
      });
    }

    if (addedEdges.length > 0) {
      await writeGraph(graph);
    }

    return {
      graph,
      loopEdges: loopEdges.map(({ from, to, label }) => ({ from, to, label })),
      addedEdges,
      skippedEdges,
    };
  });
}
