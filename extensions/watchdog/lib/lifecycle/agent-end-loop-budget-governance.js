import { CONTRACT_STATUS } from "../core/runtime-status.js";

function normalizePositiveInteger(value, fallback = null) {
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) {
    return Math.trunc(numeric);
  }
  return fallback;
}

export function normalizeLoopBudgetState(activeLoopSession, contractStage) {
  const source = activeLoopSession?.budget;
  if (!source || typeof source !== "object") {
    return null;
  }

  const currentRound = normalizePositiveInteger(
    contractStage?.round ?? activeLoopSession?.round,
    1,
  ) || 1;
  return {
    maxRounds: normalizePositiveInteger(source.maxRounds, null),
    maxExperiments: normalizePositiveInteger(source.maxExperiments, null),
    usedRounds: normalizePositiveInteger(source.usedRounds, currentRound) || currentRound,
    usedExperiments: normalizePositiveInteger(source.usedExperiments, 0) || 0,
  };
}

export function evaluateLoopBudgetGovernance({
  activeLoopSession,
  contractStage,
  nextStage,
  nextRound,
}) {
  const budget = normalizeLoopBudgetState(activeLoopSession, contractStage);
  if (!budget) {
    return {
      exhausted: false,
      updatedBudget: null,
    };
  }

  const nextUsedExperiments = budget.usedExperiments + 1;
  const normalizedNextRound = normalizePositiveInteger(nextRound, contractStage?.round || 1)
    || contractStage?.round
    || 1;
  if (budget.maxExperiments && nextUsedExperiments >= budget.maxExperiments) {
    return {
      exhausted: true,
      reason: "loop_budget_exhausted:max_experiments",
      updatedBudget: {
        ...budget,
        usedExperiments: nextUsedExperiments,
      },
      terminalOutcome: {
        status: CONTRACT_STATUS.COMPLETED,
        source: "loop_runtime_governance",
        reason: "loop_budget_exhausted:max_experiments",
        summary: `Loop reached maxExperiments=${budget.maxExperiments} after stage ${contractStage?.stage || "unknown"}`,
        artifact: {
          loopId: contractStage?.loopId || contractStage?.pipelineId || null,
          loopSessionId: contractStage?.loopSessionId || null,
          exhaustedBy: "maxExperiments",
          maxExperiments: budget.maxExperiments,
          usedExperiments: nextUsedExperiments,
          blockedNextStage: nextStage || null,
        },
      },
    };
  }
  if (budget.maxRounds && normalizedNextRound > budget.maxRounds) {
    return {
      exhausted: true,
      reason: "loop_budget_exhausted:max_rounds",
      updatedBudget: {
        ...budget,
        usedRounds: budget.maxRounds,
        usedExperiments: nextUsedExperiments,
      },
      terminalOutcome: {
        status: CONTRACT_STATUS.COMPLETED,
        source: "loop_runtime_governance",
        reason: "loop_budget_exhausted:max_rounds",
        summary: `Loop reached maxRounds=${budget.maxRounds} before routing to ${nextStage}`,
        artifact: {
          loopId: contractStage?.loopId || contractStage?.pipelineId || null,
          loopSessionId: contractStage?.loopSessionId || null,
          exhaustedBy: "maxRounds",
          maxRounds: budget.maxRounds,
          usedRounds: budget.maxRounds,
          blockedNextStage: nextStage || null,
        },
      },
    };
  }

  return {
    exhausted: false,
    updatedBudget: {
      ...budget,
      usedRounds: Math.max(budget.usedRounds, normalizedNextRound),
      usedExperiments: nextUsedExperiments,
    },
  };
}
