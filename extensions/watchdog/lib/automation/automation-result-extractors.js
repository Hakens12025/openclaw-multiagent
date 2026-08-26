import { normalizeString } from "../core/normalize.js";
import { normalizeExecutionObservation } from "../stage/execution-observation.js";
import { normalizeFiniteNumber } from "./automation-decision.js";

export function extractContractScore(contract) {
  const candidates = [
    contract?.terminalOutcome?.score,
    contract?.runtimeDiagnostics?.score,
  ];
  for (const candidate of candidates) {
    const normalized = normalizeFiniteNumber(candidate, null);
    if (normalized != null) return normalized;
  }
  return null;
}

function extractArtifactPath(value) {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (value && typeof value === "object") {
    const path = normalizeString(value.path || value.artifactPath || value.output || value.file);
    if (path) return path;
  }
  return null;
}

export function extractContractArtifact(contract) {
  const executionObservation = normalizeExecutionObservation(contract?.executionObservation || null);
  return extractArtifactPath(
    contract?.terminalOutcome?.artifact
    || executionObservation.primaryOutputPath
    || executionObservation.artifactPaths[0]
    || contract?.output
    || null,
  );
}

export function extractContractSummary(contract) {
  return normalizeString(
    contract?.terminalOutcome?.summary
    || contract?.terminalOutcome?.reason
    || contract?.terminalOutcome?.clarification
    || contract?.clarification
    || contract?.task,
  ) || null;
}
