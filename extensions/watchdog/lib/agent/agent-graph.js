/**
 * agent-graph.js — Agent graph model
 *
 * Persists a directed graph of agent relationships to agent_graph.json.
 * Nodes come from openclaw.json agents.list (not stored here).
 * Edges define directed topology between agents.
 *
 * Key exports:
 *   loadGraph()                      — read graph from disk
 *   getEdgesFrom(graph, nodeId)      — edges where from === nodeId
 *   getEdgesTo(graph, nodeId)        — edges where to === nodeId
 *   hasDirectedEdge(graph, from, to) — whether an explicit directed edge exists
 *   detectCycles(graph)              — all cycles via DFS coloring
 *   getTransitionsForNode(graph, id) — target node IDs from out-edges
 *
 * Mutation helpers live in agent-graph-mutations.js so runtime graph writes
 * stay behind formal control surfaces instead of the public read model.
 */

import { readFile } from "node:fs/promises";
import { CONTROL_PLANE_PATHS } from "../control-plane/control-plane-paths.js";

const GRAPH_FILE = CONTROL_PLANE_PATHS.agentGraphFile;

function normalizeEdge(edge) {
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
