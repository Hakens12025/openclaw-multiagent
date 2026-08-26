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
import { CONTROL_PLANE_PATHS, resolveOwnedStorePath } from "../control-plane/control-plane-paths.js";

// 路径解析(惰性种子,与 threads/contract-index/session-index 等六店同款)。
// 模块级常量会在【加载时】固化路径,测试的环境种子再怎么设也进不来——图是
// control-plane 里最后一个漏掉种子的真值,单测因此长年直写生产图
// (2026-08-11 起的"图边被洗"事故族根因)。每次 IO 现解析即可。
export function resolveAgentGraphFile() {
  // 店根门卫单源(control-plane-paths §13):图是最后一个漏种子的真值,门卫后手跑也进不了生产图。
  return resolveOwnedStorePath("OPENCLAW_AGENT_GRAPH_FILE", CONTROL_PLANE_PATHS.agentGraphFile, "agent-graph.json");
}

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
    const raw = await readFile(resolveAgentGraphFile(), "utf8");
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

// 一张图,两种读法。投递授权面(hasDirectedEdge / authorizeDispatchEdge)读全部边——
// 传送带 dispatch 的边覆盖校验(含成环图上的回边),边越多越宽松;自动选路面读本函数——平台
// 在没有显式目标时替 agent 决定下一跳,必须唯一确定。
//
// 注意:动态协作(assign_task / wake_agent)一次都不读这张图,授权单源
// 是 collaboration-intent-policy 的角色表。图边只管固定管线与传送带投递。
//
// 两者共用一张图但要求相反:给 controller 加第二条边能放宽它的投递面,却会让 ingress
// 首跳解析不出唯一答案。metadata.pipeline 就是把这两件事分开的标记。
//
// 一条都没标时全部边都是管线边:图会被 reset 清空、被测试夹具重建,硬要求标记会让
// 自动选路对自己的测试夹具变脆。
export function getPipelineEdgesFrom(graph, nodeId) {
  const edges = getEdgesFrom(graph, nodeId);
  const marked = edges.filter((edge) => edge.metadata?.pipeline === true);
  return marked.length > 0 ? marked : edges;
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
