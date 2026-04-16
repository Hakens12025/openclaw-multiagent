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

export function extractPipelineScore(pipeline) {
  const candidates = [
    pipeline?.feedbackOutput?.result?.score,
    pipeline?.feedbackOutput?.score,
    pipeline?.conclusionArtifact?.score,
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

export function extractPipelineArtifact(pipeline) {
  return extractArtifactPath(
    pipeline?.conclusionArtifact
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

export function extractPipelineSummary(pipeline) {
  return normalizeString(
    pipeline?.feedbackOutput?.feedback
    || pipeline?.feedbackOutput?.result?.summary
    || pipeline?.concludeReason
    || pipeline?.requestedTask,
  ) || null;
}

export function derivePipelineTerminalStatus(pipeline) {
  const explicit = normalizeString(
    pipeline?.feedbackOutput?.result?.status
  )?.toLowerCase();
  if (explicit && isTerminalContractStatus(explicit)) {
    return explicit;
  }
  return CONTRACT_STATUS.COMPLETED;
}
