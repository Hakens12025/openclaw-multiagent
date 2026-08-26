import { mergeContractFields, updateContractStatus, writeTaskState } from "../contract/contracts.js";
import { qqTypingStop } from "../transport/channel-notify.js";
import { CONTRACT_STATUS } from "../core/runtime-status.js";
import { refreshTrackingProjection } from "../stage/stage-projection.js";
import { materializeTaskStageTruth } from "../stage/task-stage-truth.js";
import { normalizeTerminalOutcome } from "../contract/terminal-outcome.js";
import { removeDispatchContract } from "./dispatch/dispatch-runtime-state.js";

function buildTerminalLabel(terminalStatus, terminalOutcome) {
  if (terminalStatus === CONTRACT_STATUS.COMPLETED) {
    return "已完成";
  }
  return `语义失败: ${(terminalOutcome?.reason || "未满足 contract 完成条件").slice(0, 160)}`;
}

function buildTerminalExtraFields(terminalStatus, terminalOutcome, extraFields = null) {
  const baseFields = {
    terminalOutcome: normalizeTerminalOutcome(terminalOutcome, { terminalStatus }),
  };
  return extraFields ? { ...baseFields, ...extraFields } : baseFields;
}

function buildCanonicalTerminalStageFields(contract, terminalStatus, terminalExtraFields) {
  if (terminalStatus !== CONTRACT_STATUS.COMPLETED || !contract) {
    return terminalExtraFields;
  }

  const effectiveContract = {
    ...contract,
    status: terminalStatus,
    ...terminalExtraFields,
  };
  const truth = materializeTaskStageTruth({
    contractId: effectiveContract.id || effectiveContract.contractId || null,
    stagePlan: effectiveContract.stagePlan ?? null,
    stageRuntime: effectiveContract.stageRuntime ?? null,
    executionObservation: effectiveContract.executionObservation ?? null,
    terminalOutcome: effectiveContract.terminalOutcome ?? null,
    runtimeDiagnostics: effectiveContract.runtimeDiagnostics ?? null,
    systemActionDelivery: effectiveContract.systemActionDelivery ?? null,
    childContractOutcome: effectiveContract.childContractOutcome ?? null,
    phases: effectiveContract.phases ?? null,
  });

  if (!truth.stageRuntime) {
    return terminalExtraFields;
  }

  return {
    ...terminalExtraFields,
    stageRuntime: truth.stageRuntime,
  };
}

export async function commitSemanticTerminalState({
  trackingState,
  terminalStatus,
  terminalOutcome,
  logger,
  extraFields,
}) {
  if (!trackingState) {
    return { committed: false, reason: "missing_tracking_state" };
  }

  trackingState.status = terminalStatus;
  trackingState.lastLabel = buildTerminalLabel(terminalStatus, terminalOutcome);

  if (!trackingState.contract) {
    return { committed: false, reason: "missing_contract" };
  }

  trackingState.contract.status = terminalStatus;

  const terminalExtraFields = buildCanonicalTerminalStageFields(
    trackingState.contract,
    terminalStatus,
    buildTerminalExtraFields(terminalStatus, terminalOutcome, extraFields),
  );
  Object.assign(trackingState.contract, terminalExtraFields);
  const persistResult = await updateContractStatus(trackingState.contract.path, terminalStatus, logger, terminalExtraFields);
  if (!persistResult?.ok) {
    logger.error(`[terminal-commit] contract status persist failed for ${trackingState.contract.id}, retrying...`);
    const retry = await updateContractStatus(trackingState.contract.path, terminalStatus, logger, terminalExtraFields);
    if (!retry?.ok) {
      logger.error(`[terminal-commit] contract status persist retry also failed: ${retry?.error}`);
      return { committed: false, reason: "contract_persist_failed", error: retry?.error };
    }
  }
  await removeDispatchContract(trackingState.contract.id, logger);
  await refreshTrackingProjection(trackingState);
  await writeTaskState(trackingState, logger);
  qqTypingStop(trackingState.contract.id);

  return {
    committed: true,
    contractStatus: terminalStatus,
    extraFields: terminalExtraFields,
  };
}

export async function mergeTrackingContractFields({
  trackingState,
  extraFields,
  logger,
}) {
  if (!trackingState) {
    return { committed: false, reason: "missing_tracking_state" };
  }

  if (!trackingState.contract) {
    return { committed: false, reason: "missing_contract" };
  }

  if (!extraFields || typeof extraFields !== "object" || Object.keys(extraFields).length === 0) {
    return { committed: false, reason: "missing_extra_fields" };
  }

  Object.assign(trackingState.contract, extraFields);
  await mergeContractFields(trackingState.contract.path, logger, extraFields);
  await writeTaskState(trackingState, logger);

  return {
    committed: true,
    extraFields,
  };
}
