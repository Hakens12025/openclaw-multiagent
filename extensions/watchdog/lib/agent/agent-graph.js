/**
 * agent-graph.js — Agent graph model
 *
 * Persists a directed graph of agent relationships to agent_graph.json.
 * Nodes come from openclaw.json agents.list (not stored here).
 * Edges define transitions between agents with optional gates and metadata.
 *
 * Key exports:
 *   loadGraph()                      — read graph from disk
 *   saveGraph(graph)                 — atomic write graph to disk
 *   addEdge(from, to, opts)          — add edge
 *   removeEdge(from, to)             — remove edge(s) matching from+to
 *   getEdgesFrom(graph, nodeId)      — edges where from === nodeId
 *   getEdgesTo(graph, nodeId)        — edges where to === nodeId
 *   hasDirectedEdge(graph, from, to) — whether an explicit directed edge exists
 *   detectCycles(graph)              — all cycles via DFS coloring
 *   getTransitionsForNode(graph, id) — target node IDs from out-edges
 */

import { readFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { atomicWriteFile, withLock, OC } from "../state.js";

const GRAPH_FILE = join(OC, "workspaces", "controller", "agent_graph.json");
const LOCK_KEY = "agent-graph";

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

function edgeKey(edge) {
  return `${edge.from}→${edge.to}`;
}

export function normalizeGraphEdges(edges) {
  const normalized = [];
  const seen = new Set();
  for (const edge of Array.isArray(edges) ? edges : []) {
    const next = normalizeEdge(edge);
    if (!next) continue;
    const key = edgeKey(next);
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(next);
  }
  return normalized;
}

// ── Persistence ─────────────────────────────────────────────────────────────

export async function loadGraph() {
  try {
    const raw = await readFile(GRAPH_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return { edges: normalizeGraphEdges(parsed.edges) };
  } catch {
    return { edges: [] };
  }
}

export async function saveGraph(graph) {
  await withLock(LOCK_KEY, async () => {
    await mkdir(dirname(GRAPH_FILE), { recursive: true });
    await atomicWriteFile(GRAPH_FILE, JSON.stringify({
      ...graph,
      edges: normalizeGraphEdges(graph?.edges),
    }, null, 2));
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
    await mkdir(dirname(GRAPH_FILE), { recursive: true });
    await atomicWriteFile(GRAPH_FILE, JSON.stringify(nextGraph, null, 2));
    return {
      changed: true,
      graph: nextGraph,
      removedEdges,
    };
  });
}

// ── Edge mutations ──────────────────────────────────────────────────────────

export async function addEdge(from, to, opts = {}) {
  return withLock(LOCK_KEY, async () => {
    const graph = await loadGraph();
    const nextEdge = normalizeEdge({
      from,
      to,
      label: opts.label,
      gate: opts?.gate || "default",
      capability: opts?.capability || null,
      gates: opts.gates,
      metadata: opts.metadata,
    });
    if (!nextEdge) return graph;
    const exists = graph.edges.some((edge) => edge.from === nextEdge.from && edge.to === nextEdge.to);
    if (exists) return graph;
    graph.edges.push(nextEdge);
    await mkdir(dirname(GRAPH_FILE), { recursive: true });
    await atomicWriteFile(GRAPH_FILE, JSON.stringify(graph, null, 2));
    return graph;
  });
}

export async function removeEdge(from, to) {
  return withLock(LOCK_KEY, async () => {
    const graph = await loadGraph();
    graph.edges = graph.edges.filter(
      (e) => !(e.from === from && e.to === to),
    );
    await mkdir(dirname(GRAPH_FILE), { recursive: true });
    await atomicWriteFile(GRAPH_FILE, JSON.stringify(graph, null, 2));
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
        gates: Array.isArray(opts.gates) ? opts.gates : [],
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
      await mkdir(dirname(GRAPH_FILE), { recursive: true });
      await atomicWriteFile(GRAPH_FILE, JSON.stringify(graph, null, 2));
    }

    return {
      graph,
      loopEdges: loopEdges.map(({ from, to, label }) => ({ from, to, label })),
      addedEdges,
      skippedEdges,
    };
  });
}

// ── Query helpers ───────────────────────────────────────────────────────────

export function getEdgesFrom(graph, nodeId) {
  return (graph?.edges || []).filter((e) => e.from === nodeId);
}

export function getEdgesTo(graph, nodeId) {
  return (graph?.edges || []).filter((e) => e.to === nodeId);
}

export function getTransitionsForNode(graph, nodeId) {
  return getEdgesFrom(graph, nodeId).map((e) => e.to);
}

export function hasDirectedEdge(graph, fromNodeId, toNodeId) {
  return getEdgesFrom(graph, fromNodeId).some((edge) => edge.to === toNodeId);
}

export function getEdgesFromByGate(graph, nodeId, gate) {
  return getEdgesFrom(graph, nodeId).filter((e) => (e.gate || "default") === gate);
}

export function getEdgesFromByCapability(graph, nodeId, capability) {
  return getEdgesFrom(graph, nodeId).filter((e) => e.capability === capability);
}

// ── Cycle detection (DFS with coloring) ─────────────────────────────────────

const WHITE = 0; // unvisited
const GRAY = 1;  // in current DFS path
const BLACK = 2; // fully explored

export function detectCycles(graph) {
  const edges = graph?.edges || [];
  if (edges.length === 0) return [];

  // Build adjacency list
  const adj = new Map();
  for (const edge of edges) {
    if (!adj.has(edge.from)) adj.set(edge.from, []);
    adj.get(edge.from).push(edge.to);
    // ensure "to" nodes exist in adj even with no outgoing edges
    if (!adj.has(edge.to)) adj.set(edge.to, []);
  }

  const color = new Map();
  const parent = new Map();
  const cycles = [];

  for (const node of adj.keys()) {
    color.set(node, WHITE);
  }

  function dfs(u) {
    color.set(u, GRAY);
    for (const v of adj.get(u) || []) {
      if (color.get(v) === GRAY) {
        // Back edge found — trace cycle
        const cycle = [v];
        let cur = u;
        while (cur !== v) {
          cycle.push(cur);
          cur = parent.get(cur);
        }
        cycle.reverse();
        cycles.push(cycle);
      } else if (color.get(v) === WHITE) {
        parent.set(v, u);
        dfs(v);
      }
    }
    color.set(u, BLACK);
  }

  for (const node of adj.keys()) {
    if (color.get(node) === WHITE) {
      dfs(node);
    }
  }

  return cycles;
}
