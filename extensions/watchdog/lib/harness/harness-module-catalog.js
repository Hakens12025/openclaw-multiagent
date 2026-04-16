import { normalizeString, uniqueStrings } from "../core/normalize.js";

function freezeCatalog(values) {
  return Object.freeze(values.map((entry) => Object.freeze({
    id: entry.id,
    kind: entry.kind,
    hardShaped: Object.freeze(uniqueStrings(entry.hardShaped || [])),
  })));
}

const HARNESS_MODULE_CATALOG = freezeCatalog([
  { id: "harness:guard.budget", kind: "guard", hardShaped: ["timeout_budget", "cancellation_boundary", "retry_budget"] },
  { id: "harness:guard.tool_access", kind: "guard", hardShaped: ["tool_surface_whitelist", "network_boundary"] },
  { id: "harness:guard.scope", kind: "guard", hardShaped: ["sandbox_boundary", "workspace_scope"] },
  { id: "harness:collector.artifact", kind: "collector", hardShaped: ["artifact_capture", "diff_capture"] },
  { id: "harness:collector.trace", kind: "collector", hardShaped: ["trace_capture", "log_capture"] },
  { id: "harness:gate.artifact", kind: "gate", hardShaped: ["required_artifact_gate", "stage_artifact_set_gate", "experiment_status_gate", "review_artifact_gate"] },
  { id: "harness:gate.schema", kind: "gate", hardShaped: ["schema_gate", "stage_schema_gate", "review_finding_schema"] },
  { id: "harness:gate.test", kind: "gate", hardShaped: ["test_gate"] },
  { id: "harness:normalizer.eval_input", kind: "normalizer", hardShaped: ["evaluation_input_normalization", "stage_evaluation_input"] },
  { id: "harness:normalizer.failure", kind: "normalizer", hardShaped: ["failure_classification", "review_verdict_normalization"] },
]);

export function resolveHarnessModuleCatalogId(moduleId) {
  const normalizedId = normalizeString(moduleId);
  if (!normalizedId) return null;
  return HARNESS_MODULE_CATALOG.some((entry) => entry.id === normalizedId) ? normalizedId : null;
}

export function listHarnessModuleCatalog() {
  return [...HARNESS_MODULE_CATALOG];
}

export function getHarnessModuleCatalogEntry(moduleId) {
  const resolvedId = resolveHarnessModuleCatalogId(moduleId);
  if (resolvedId === null) return null;
  return HARNESS_MODULE_CATALOG.find((entry) => entry.id === resolvedId) || null;
}
