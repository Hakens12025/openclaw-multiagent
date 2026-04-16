import { readFile } from "node:fs/promises";

import { HOME } from "../state.js";
import { CONTRACT_STATUS } from "../core/runtime-status.js";
import { normalizeExecutionObservation } from "../execution-observation.js";
import { normalizeTerminalOutcome } from "../terminal-outcome.js";
import {
  listStageArtifactPaths,
  normalizeStageCompletion,
  normalizeStageRunResult,
} from "../stage-results.js";

export function buildRuntimeDeliveryResultSource({
  trackingState = null,
  contractData = null,
} = {}) {
  const contract = contractData || trackingState?.contract || null;
  const executionObservation = normalizeExecutionObservation(
    contractData?.executionObservation || trackingState?.contract?.executionObservation || null,
    {
      contractId: contract?.id || null,
      fallbackPrimaryOutputPath: contract?.output || null,
    },
  );
  const stageRunResult = normalizeStageRunResult(
    executionObservation.stageRunResult || null,
  );
  const stageCompletionSource = executionObservation.stageCompletion || null;
  const stageCompletion = stageCompletionSource || stageRunResult?.completion
    ? normalizeStageCompletion(
        stageCompletionSource,
        stageRunResult?.completion || {},
      )
    : null;
  const terminalOutcome = normalizeTerminalOutcome(
    contractData?.terminalOutcome || trackingState?.contract?.terminalOutcome || null,
    { terminalStatus: contract?.status || null },
  );

  return {
    executionObservation,
    stageRunResult,
    stageCompletion,
    terminalOutcome,
    contract,
  };
}

function normalizeRuntimePath(value) {
  return typeof value === "string" && value.trim()
    ? String(value).replace(/^~/, HOME)
    : null;
}

function resolveTerminalOutcomeArtifactPath(terminalOutcome) {
  const artifact = terminalOutcome?.artifact;
  if (!artifact) return null;
  if (typeof artifact === "string") {
    return normalizeRuntimePath(artifact);
  }
  if (artifact && typeof artifact === "object") {
    return normalizeRuntimePath(artifact.path);
  }
  return null;
}

export function resolveRuntimeResultOutputPath(source) {
  if (!source) return null;
  if (typeof source === "string") {
    return normalizeRuntimePath(source);
  }

  const executionObservation = normalizeExecutionObservation(
    source?.executionObservation || source?.contract?.executionObservation || null,
    {
      contractId: source?.contract?.id || source?.contractId || null,
      fallbackPrimaryOutputPath: source?.contract?.output || source?.output || null,
    },
  );
  const terminalOutcome = normalizeTerminalOutcome(
    source?.terminalOutcome || source?.contract?.terminalOutcome || null,
    { terminalStatus: source?.contract?.status || null },
  );
  const stageRunResult = normalizeStageRunResult(
    executionObservation.stageRunResult || null,
  );
  const terminalArtifactPath = resolveTerminalOutcomeArtifactPath(terminalOutcome);
  const stageArtifactPath = terminalArtifactPath
    || normalizeRuntimePath(stageRunResult?.primaryArtifactPath)
    || listStageArtifactPaths(stageRunResult).map(normalizeRuntimePath).find(Boolean)
    || normalizeRuntimePath(executionObservation.primaryOutputPath)
    || executionObservation.artifactPaths.map(normalizeRuntimePath).find(Boolean)
    || normalizeRuntimePath(source?.primaryOutputPath)
    || (Array.isArray(source?.artifactPaths) ? source.artifactPaths.map(normalizeRuntimePath).find(Boolean) : null);

  return stageArtifactPath;
}

function resolveRuntimeResultFallbackText(source) {
  if (!source || typeof source === "string") return "";
  const executionObservation = normalizeExecutionObservation(
    source?.executionObservation || source?.contract?.executionObservation || null,
    {
      contractId: source?.contract?.id || source?.contractId || null,
      fallbackPrimaryOutputPath: source?.contract?.output || source?.output || null,
    },
  );
  const terminalOutcome = normalizeTerminalOutcome(
    source?.terminalOutcome || source?.contract?.terminalOutcome || null,
    { terminalStatus: source?.contract?.status || null },
  );
  const stageRunResult = normalizeStageRunResult(
    executionObservation.stageRunResult || null,
  );
  const stageCompletionSource = executionObservation.stageCompletion || null;
  const stageCompletion = stageCompletionSource || stageRunResult?.completion
    ? normalizeStageCompletion(
        stageCompletionSource,
        stageRunResult?.completion || {},
      )
    : null;
  return terminalOutcome?.summary
    || terminalOutcome?.clarification
    || terminalOutcome?.reason
    || stageCompletion?.feedback
    || stageRunResult?.summary
    || stageRunResult?.feedback
    || "";
}

export async function readRuntimeResultContent(source) {
  const outputPath = resolveRuntimeResultOutputPath(source);
  if (!outputPath) return resolveRuntimeResultFallbackText(source);
  try {
    return await readFile(outputPath, "utf8");
  } catch {
    return resolveRuntimeResultFallbackText(source);
  }
}

export async function readDeliveryResultContent(outputPath) {
  return readRuntimeResultContent(outputPath);
}

export function summarizeDeliveryResult(text, limit = 1200) {
  const clean = String(text || "").trim();
  if (!clean) return "";
  return clean.length > limit ? `${clean.slice(0, limit)}...` : clean;
}

export function summarizeDeliveryResultPayload({
  resultContent = "",
  outcome = null,
  source = null,
  limit = 1200,
} = {}) {
  const normalizedContent = summarizeDeliveryResult(resultContent, limit);
  if (normalizedContent) {
    return normalizedContent;
  }

  const terminalOutcome = normalizeTerminalOutcome(
    source?.terminalOutcome || outcome || null,
    { terminalStatus: source?.contract?.status || source?.terminalOutcome?.status || outcome?.status || null },
  );
  return summarizeDeliveryResult(
    terminalOutcome?.summary
      || terminalOutcome?.clarification
      || terminalOutcome?.reason
      || "",
    limit,
  );
}

export function buildSystemActionDeliveryResult({
  deliveryId = null,
  handled = false,
  targetAgent = null,
  contractId = null,
  workflow = null,
  status = null,
  verdict = null,
  reason = null,
  artifactType = null,
  semanticArtifactType = null,
  semanticWorkflow = null,
  wake = null,
  error = null,
  duplicate = false,
  skipped = false,
  suppressCompletionEgress = false,
  nestedDelivery = null,
  conclusionReason = null,
  conclusionArtifact = null,
  deliveryTicketId = null,
} = {}) {
  const result = {
    deliveryId: deliveryId || null,
    handled: handled === true,
    targetAgent: targetAgent || null,
    contractId: contractId || null,
    workflow: workflow || null,
    status: status || null,
    verdict: verdict || null,
    reason: reason || null,
    artifactType: artifactType || null,
    semanticArtifactType: semanticArtifactType || null,
    semanticWorkflow: semanticWorkflow || null,
    deliveryTicketId: deliveryTicketId || null,
    wake: wake || null,
    error: error || null,
  };

  if (duplicate === true) result.duplicate = true;
  if (skipped === true) result.skipped = true;
  if (suppressCompletionEgress === true) result.suppressCompletionEgress = true;
  if (nestedDelivery && typeof nestedDelivery === "object") result.nestedDelivery = nestedDelivery;
  if (conclusionReason) result.conclusionReason = conclusionReason;
  if (conclusionArtifact) result.conclusionArtifact = conclusionArtifact;

  return result;
}

export function buildContractResultDeliveryTask({
  header,
  successInstruction,
  awaitingInputInstruction,
  failureInstruction,
  taskLabel = "子流程任务",
  taskSummary,
  terminalStatus,
  outcome,
  resultContent,
  resultContentLabel = "结果内容",
  resultReasonLabel = "结果说明",
} = {}) {
  if (terminalStatus === CONTRACT_STATUS.COMPLETED) {
    return [
      header,
      successInstruction,
      "",
      `${taskLabel}: ${taskSummary || "未知任务"}`,
      "",
      resultContent
        ? `${resultContentLabel}:\n${summarizeDeliveryResult(resultContent)}`
        : `${resultReasonLabel}: ${outcome?.reason || "子流程已完成"}`,
    ].filter(Boolean).join("\n");
  }

  const statusLine = terminalStatus === CONTRACT_STATUS.AWAITING_INPUT
    ? awaitingInputInstruction
    : failureInstruction;

  return [
    header,
    statusLine,
    "",
    `${taskLabel}: ${taskSummary || "未知任务"}`,
    `状态: ${terminalStatus}`,
    `原因: ${outcome?.clarification || outcome?.reason || "未提供"}`,
  ].filter(Boolean).join("\n");
}
