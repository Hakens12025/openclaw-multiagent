import { planWithOperatorBrain } from "./operator/operator-brain.js";
import { executeOperatorExecutablePlan } from "./operator/operator-executor.js";
import {
  buildOperatorAdviceFallback,
  buildOperatorInvalidPlanFallback,
} from "./operator-fallback.js";
import { normalizeOperatorBrainPlanResult } from "./operator/operator-plan.js";
import { normalizeString } from "./core/normalize.js";

export async function buildOperatorPlan({
  message,
  history = [],
  currentPlan = null,
  logger = null,
} = {}) {
  const requestText = normalizeString(message);
  if (!requestText) {
    throw new Error("missing message");
  }

  let brainResult;
  try {
    brainResult = await planWithOperatorBrain({
      message: requestText,
      history,
      currentPlan,
      logger,
    });
  } catch (error) {
    logger?.warn?.(`[watchdog] operator-brain unavailable, advice-only fallback: ${error.message}`);
    return buildOperatorAdviceFallback({
      requestText,
      error,
    });
  }

  try {
    return normalizeOperatorBrainPlanResult(brainResult, requestText);
  } catch (error) {
    logger?.warn?.(`[watchdog] operator-brain produced invalid plan, advice-only fallback: ${error.message}`);
    return buildOperatorInvalidPlanFallback({
      requestText,
      error,
      brainResult,
    });
  }
}

export async function executeOperatorPlan({
  plan,
  logger = null,
  onAlert = null,
  runtimeContext = null,
  dryRun = false,
} = {}) {
  return executeOperatorExecutablePlan({
    plan,
    logger,
    onAlert,
    runtimeContext,
    dryRun,
  });
}
