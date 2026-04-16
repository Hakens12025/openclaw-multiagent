import { detectCycles, loadGraph } from "../agent/agent-graph.js";
import { executeAdminSurfaceOperation } from "../admin/admin-surface-operations.js";
import { normalizeOperatorPlan } from "./operator-plan.js";

function summarizeGraphState(graph) {
  const cycles = detectCycles(graph);
  return {
    edgeCount: Array.isArray(graph?.edges) ? graph.edges.length : 0,
    cycleCount: cycles.length,
    cycles,
  };
}

export async function executeOperatorExecutablePlan({
  plan,
  logger = null,
  onAlert = null,
  runtimeContext = null,
  dryRun = false,
} = {}) {
  const normalizedPlan = normalizeOperatorPlan(plan);

  if (dryRun === true) {
    const graph = await loadGraph();
    return {
      ok: true,
      dryRun: true,
      summary: normalizedPlan.summary,
      plan: normalizedPlan,
      graph: summarizeGraphState(graph),
    };
  }

  const results = [];
  for (const step of normalizedPlan.steps) {
    const result = await executeAdminSurfaceOperation({
      surfaceId: step.surfaceId,
      payload: step.payload,
      logger,
      onAlert,
      runtimeContext,
    });
    results.push({
      surfaceId: step.surfaceId,
      title: step.title,
      summary: step.summary,
      payload: step.payload,
      result,
    });
  }

  const graph = await loadGraph();
  return {
    ok: true,
    dryRun: false,
    executedAt: Date.now(),
    summary: normalizedPlan.summary,
    plan: normalizedPlan,
    results,
    graph: summarizeGraphState(graph),
  };
}
