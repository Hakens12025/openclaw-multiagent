import { evaluateContractOutcome } from "./contracts.js";
import { CONTRACT_STATUS } from "./core/runtime-status.js";
import {
  normalizeBoolean,
  normalizeFiniteNumber,
  normalizeRecord,
  normalizeString,
} from "./core/normalize.js";

function normalizeTerminalArtifact(value) {
  const normalizedPath = normalizeString(value);
  if (normalizedPath) {
    return normalizedPath;
  }
  return normalizeRecord(value, null);
}

export function normalizeTerminalOutcome(outcome, {
  terminalStatus = null,
  ts = null,
} = {}) {
  const source = normalizeRecord(outcome, {});
  const status = normalizeString(
    terminalStatus
    || source.status
    || CONTRACT_STATUS.FAILED,
  ) || CONTRACT_STATUS.FAILED;
  return {
    version: Number.isFinite(source.version) ? Math.max(1, Math.trunc(source.version)) : 1,
    status,
    source: normalizeString(source.source) || "session",
    reason: normalizeString(source.reason) || null,
    summary: normalizeString(source.summary) || null,
    clarification: normalizeString(source.clarification) || null,
    verdict: normalizeString(source.verdict) || null,
    score: normalizeFiniteNumber(source.score, null),
    testsPassed: normalizeBoolean(source.testsPassed),
    actionType: normalizeString(source.actionType) || null,
    retryable: source.retryable === true,
    artifact: normalizeTerminalArtifact(source.artifact),
    ts: Number.isFinite(source.ts) ? source.ts : (Number.isFinite(ts) ? ts : Date.now()),
  };
}

function mapOutcomeToTerminalStatus(outcome) {
  if (outcome?.status === CONTRACT_STATUS.AWAITING_INPUT) {
    return CONTRACT_STATUS.AWAITING_INPUT;
  }
  if (outcome?.status === CONTRACT_STATUS.COMPLETED) {
    return CONTRACT_STATUS.COMPLETED;
  }
  return CONTRACT_STATUS.FAILED;
}

export async function resolveTerminalOutcome({
  trackingState,
  contractData,
  executionObservation,
  logger,
}) {
  if (!trackingState?.contract) {
    const terminalOutcome = normalizeTerminalOutcome({
      status: CONTRACT_STATUS.COMPLETED,
      reason: "session completed",
      source: "session",
    }, {
      terminalStatus: CONTRACT_STATUS.COMPLETED,
    });
    return {
      terminalOutcome,
      terminalStatus: terminalOutcome.status,
    };
  }

  const effectiveContract = contractData || trackingState.contract;
  const outcome = await evaluateContractOutcome(effectiveContract, executionObservation, logger);
  const terminalOutcome = normalizeTerminalOutcome(outcome, {
    terminalStatus: mapOutcomeToTerminalStatus(outcome),
  });

  return {
    terminalOutcome,
    terminalStatus: terminalOutcome.status,
  };
}
