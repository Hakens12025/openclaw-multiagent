import { detectCycles, loadGraph } from "../agent/agent-graph.js";

export async function inspectCliSystemGraphState() {
  const graph = await loadGraph();
  const cycles = detectCycles(graph);
  return {
    edgeCount: Array.isArray(graph?.edges) ? graph.edges.length : 0,
    cycleCount: cycles.length,
    cycles,
  };
}
