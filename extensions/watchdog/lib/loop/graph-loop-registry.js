import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { detectCycles, hasDirectedEdge, loadGraph } from "../agent/agent-graph.js";
import { normalizeRecord, normalizeString, uniqueStrings } from "../core/normalize.js";
import { OC, atomicWriteFile, withLock } from "../state.js";

const GRAPH_LOOP_FILE = join(OC, "workspaces", "controller", "graph_loops.json");
const GRAPH_LOOP_LOCK_KEY = "graph-loop-registry";
const DEFAULT_LOOP_KIND = "cycle-loop";
const DEFAULT_CONTINUE_SIGNAL = "continue";
const DEFAULT_CONCLUDE_SIGNAL = "conclude";

function slugify(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function buildLoopId(agentIds) {
  const normalizedNodes = uniqueStrings(agentIds);
  return `loop-${normalizedNodes.map((agentId) => slugify(agentId)).filter(Boolean).join("-") || "graph"}`;
}

function buildLoopEdges(nodes, label = null) {
  return nodes.map((from, index) => ({
    from,
    to: nodes[(index + 1) % nodes.length],
    ...(normalizeString(label) ? { label: normalizeString(label) } : {}),
  }));
}

function normalizeLoopSpecEntry(value) {
  const source = normalizeRecord(value, null);
  if (!source) {
    return null;
  }

  const nodes = uniqueStrings(source.nodes);
  if (nodes.length < 2) {
    return null;
  }

  const entryAgentId = normalizeString(source.entryAgentId);
  const phaseOrder = uniqueStrings(source.phaseOrder);
  const metadata = normalizeRecord(source.metadata, null);

  return {
    id: normalizeString(source.id) || buildLoopId(nodes),
    kind: normalizeString(source.kind) || DEFAULT_LOOP_KIND,
    ...(normalizeString(source.label) ? { label: normalizeString(source.label) } : {}),
    nodes,
    entryAgentId: nodes.includes(entryAgentId) ? entryAgentId : nodes[0],
    ...(phaseOrder.length > 0 ? { phaseOrder } : {}),
    continueSignal: normalizeString(source.continueSignal) || DEFAULT_CONTINUE_SIGNAL,
    concludeSignal: normalizeString(source.concludeSignal) || DEFAULT_CONCLUDE_SIGNAL,
    ...(metadata && Object.keys(metadata).length > 0 ? { metadata } : {}),
  };
}

function cyclesMatchNodes(nodes, cycle) {
  const normalizedNodes = uniqueStrings(nodes);
  const normalizedCycle = uniqueStrings(cycle);
  if (normalizedNodes.length === 0 || normalizedNodes.length !== normalizedCycle.length) {
    return false;
  }

  for (let index = 0; index < normalizedCycle.length; index += 1) {
    const rotated = [
      ...normalizedCycle.slice(index),
      ...normalizedCycle.slice(0, index),
    ];
    if (rotated.every((agentId, rotatedIndex) => agentId === normalizedNodes[rotatedIndex])) {
      return true;
    }
  }
  return false;
}

export function composeLoopSpecFromAgents(agentIds, opts = {}) {
  const metadata = normalizeRecord(opts.metadata, null);
  return normalizeLoopSpecEntry({
    id: opts.loopId || opts.id || buildLoopId(agentIds),
    kind: opts.kind || DEFAULT_LOOP_KIND,
    label: opts.label,
    nodes: agentIds,
    entryAgentId: opts.entryAgentId || agentIds[0],
    phaseOrder: opts.phaseOrder,
    continueSignal: opts.continueSignal || DEFAULT_CONTINUE_SIGNAL,
    concludeSignal: opts.concludeSignal || DEFAULT_CONCLUDE_SIGNAL,
    metadata: {
      ...(metadata || {}),
      semanticStageMode: normalizeString(metadata?.semanticStageMode) || "task_stage_truth",
    },
  });
}

export async function loadGraphLoopRegistry() {
  try {
    const raw = await readFile(GRAPH_LOOP_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return {
      loops: (Array.isArray(parsed?.loops) ? parsed.loops : [])
        .map((entry) => normalizeLoopSpecEntry(entry))
        .filter(Boolean),
    };
  } catch {
    return { loops: [] };
  }
}

export async function saveGraphLoopRegistry(registry) {
  const loops = (Array.isArray(registry?.loops) ? registry.loops : [])
    .map((entry) => normalizeLoopSpecEntry(entry))
    .filter(Boolean);
  await withLock(GRAPH_LOOP_LOCK_KEY, async () => {
    await mkdir(dirname(GRAPH_LOOP_FILE), { recursive: true });
    await atomicWriteFile(GRAPH_LOOP_FILE, JSON.stringify({ loops }, null, 2));
  });
  return { loops };
}

export async function pruneGraphLoopRegistryToAgentIds(agentIds) {
  const validAgentIds = new Set(
    (Array.isArray(agentIds) ? agentIds : [])
      .map((agentId) => normalizeString(agentId))
      .filter(Boolean),
  );

  return withLock(GRAPH_LOOP_LOCK_KEY, async () => {
    const registry = await loadGraphLoopRegistry();
    const removedLoops = [];
    const keptLoops = [];

    for (const loop of registry.loops) {
      const nodes = uniqueStrings(loop?.nodes || []);
      const entryAgentId = normalizeString(loop?.entryAgentId);
      const valid = nodes.length >= 2
        && nodes.every((agentId) => validAgentIds.has(agentId))
        && (!entryAgentId || validAgentIds.has(entryAgentId));
      if (valid) {
        keptLoops.push(loop);
      } else {
        removedLoops.push(loop);
      }
    }

    if (removedLoops.length === 0) {
      return {
        changed: false,
        registry,
        removedLoops,
      };
    }

    const nextRegistry = { loops: keptLoops };
    await mkdir(dirname(GRAPH_LOOP_FILE), { recursive: true });
    await atomicWriteFile(GRAPH_LOOP_FILE, JSON.stringify(nextRegistry, null, 2));
    return {
      changed: true,
      registry: nextRegistry,
      removedLoops,
    };
  });
}

export async function upsertGraphLoopSpec(loopSpec) {
  const normalized = normalizeLoopSpecEntry(loopSpec);
  if (!normalized) {
    throw new Error("invalid loop spec");
  }

  return withLock(GRAPH_LOOP_LOCK_KEY, async () => {
    const registry = await loadGraphLoopRegistry();
    const nextLoops = registry.loops.filter((entry) => entry.id !== normalized.id);
    nextLoops.push(normalized);
    nextLoops.sort((left, right) => left.id.localeCompare(right.id));
    await mkdir(dirname(GRAPH_LOOP_FILE), { recursive: true });
    await atomicWriteFile(GRAPH_LOOP_FILE, JSON.stringify({ loops: nextLoops }, null, 2));
    return normalized;
  });
}

export function resolveGraphLoopSpec(loopSpec, graph) {
  const normalized = normalizeLoopSpecEntry(loopSpec);
  if (!normalized) {
    return null;
  }

  const loopEdges = buildLoopEdges(normalized.nodes, normalized.label || null);
  const missingEdges = loopEdges.filter((edge) => !hasDirectedEdge(graph, edge.from, edge.to));
  const cycles = detectCycles(graph);
  const cycleDetected = missingEdges.length === 0
    && cycles.some((cycle) => cyclesMatchNodes(normalized.nodes, cycle));

  return {
    ...normalized,
    loopEdges,
    missingEdges,
    active: missingEdges.length === 0,
    cycleDetected,
  };
}

export async function listResolvedGraphLoops({
  graph = null,
} = {}) {
  const [registry, effectiveGraph] = await Promise.all([
    loadGraphLoopRegistry(),
    graph ? Promise.resolve(graph) : loadGraph(),
  ]);
  return registry.loops
    .map((loopSpec) => resolveGraphLoopSpec(loopSpec, effectiveGraph))
    .filter(Boolean)
    .sort((left, right) => {
      if (left.active !== right.active) return left.active ? -1 : 1;
      return left.id.localeCompare(right.id);
    });
}

export function findActiveGraphLoopByEntryAgent(loops, agentId) {
  const normalizedAgentId = normalizeString(agentId);
  if (!normalizedAgentId) {
    return null;
  }

  return (Array.isArray(loops) ? loops : []).find((loop) => (
    loop?.active === true
    && normalizeString(loop?.entryAgentId) === normalizedAgentId
  )) || null;
}

export function findActiveGraphLoopsByMemberAgent(loops, agentId) {
  const normalizedAgentId = normalizeString(agentId);
  if (!normalizedAgentId) {
    return [];
  }

  return (Array.isArray(loops) ? loops : []).filter((loop) => (
    loop?.active === true
    && Array.isArray(loop?.nodes)
    && loop.nodes.some((node) => normalizeString(node) === normalizedAgentId)
  ));
}
