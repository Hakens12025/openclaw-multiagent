import { readFile } from "node:fs/promises";

import { getRuntimeAgentConfig } from "../agent/agent-identity.js";
import { normalizeString, uniqueStrings } from "../core/normalize.js";

const PREVIEW_LIMIT = 280;

function trimPreview(text) {
  const normalized = String(text || "").replace(/\s+/g, " ").trim();
  if (!normalized) return null;
  return normalized.length > PREVIEW_LIMIT
    ? `${normalized.slice(0, PREVIEW_LIMIT)}...`
    : normalized;
}

async function readTextPreview(filePath) {
  const normalizedPath = normalizeString(filePath);
  if (!normalizedPath) return null;
  try {
    const raw = await readFile(normalizedPath, "utf8");
    return trimPreview(raw);
  } catch {
    return null;
  }
}

function resolveEffectiveTools(agentId) {
  return uniqueStrings(getRuntimeAgentConfig(agentId)?.capabilities?.tools || []);
}

export function mergeIoObservation(existingObservation, patch) {
  const existing = existingObservation && typeof existingObservation === "object"
    ? existingObservation
    : {};
  const next = patch && typeof patch === "object" ? patch : {};
  return {
    version: 1,
    ...(existing || {}),
    ...(next || {}),
    input: {
      ...(existing.input && typeof existing.input === "object" ? existing.input : {}),
      ...(next.input && typeof next.input === "object" ? next.input : {}),
    },
    output: {
      ...(existing.output && typeof existing.output === "object" ? existing.output : {}),
      ...(next.output && typeof next.output === "object" ? next.output : {}),
    },
  };
}

export function buildInputIoObservation({
  trackingState,
  agentId,
  observedAt = Date.now(),
} = {}) {
  const contract = trackingState?.contract || null;
  const effectiveTools = resolveEffectiveTools(agentId || trackingState?.agentId || null);
  if (!contract) {
    return null;
  }

  return {
    version: 1,
    input: {
      source: "contract",
      observedAt,
      contractId: contract.id || null,
      task: contract.task || null,
      taskType: contract.taskType || null,
      assignee: contract.assignee || null,
      outputPath: contract.output || null,
      effectiveTools,
    },
  };
}

export async function buildOutputIoObservation({
  executionObservation,
  terminalOutcome = null,
  observedAt = Date.now(),
} = {}) {
  const normalizedExecutionObservation = executionObservation && typeof executionObservation === "object"
    ? executionObservation
    : null;
  if (!normalizedExecutionObservation) {
    return null;
  }

  const primaryOutputPath = normalizeString(normalizedExecutionObservation.primaryOutputPath) || null;
  const artifactPaths = uniqueStrings(normalizedExecutionObservation.artifactPaths || []);
  const textPreview = await readTextPreview(primaryOutputPath);

  return {
    version: 1,
    output: {
      source: "execution_observation",
      observedAt,
      collected: normalizedExecutionObservation.collected === true,
      routerHandlerId: normalizeString(normalizedExecutionObservation.routerHandlerId) || null,
      primaryOutputPath,
      artifactPaths,
      runtimeResultPath: normalizeString(normalizedExecutionObservation.stageRunResult?.metadata?.sourceRuntimeResultPath)
        || null,
      stageSummary: normalizeString(normalizedExecutionObservation.stageRunResult?.summary)
        || normalizeString(terminalOutcome?.summary)
        || null,
      textPreview,
    },
  };
}
