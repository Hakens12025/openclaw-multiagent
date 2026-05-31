import { normalizeString } from "../core/normalize.js";
import { normalizeExecutionObservation } from "../execution-observation.js";
import {
  CONTRACT_STATUS,
  isTerminalContractStatus,
} from "../core/runtime-status.js";
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

export function extractLoopRuntimeScore(loopRuntime) {
  const candidates = [
    loopRuntime?.feedbackOutput?.result?.score,
    loopRuntime?.feedbackOutput?.score,
    loopRuntime?.conclusionArtifact?.score,
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

export function extractLoopRuntimeArtifact(loopRuntime) {
  return extractArtifactPath(
    loopRuntime?.conclusionArtifact
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

export function extractLoopRuntimeSummary(loopRuntime) {
  return normalizeString(
    loopRuntime?.feedbackOutput?.feedback
    || loopRuntime?.feedbackOutput?.result?.summary
    || loopRuntime?.concludeReason
    || loopRuntime?.requestedTask,
  ) || null;
}

export function deriveLoopRuntimeTerminalStatus(loopRuntime) {
  const explicit = normalizeString(
    loopRuntime?.feedbackOutput?.result?.status
  )?.toLowerCase();
  if (explicit && isTerminalContractStatus(explicit)) {
    return explicit;
  }
  return CONTRACT_STATUS.COMPLETED;
}
