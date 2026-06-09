// viz-master-runtime.js — the runtime entrypoint for the visualization master meta-agent.
// Mirrors operator-runtime.js: buildVizMasterPlan wraps the viz brain + the SHARED plan
// normalizer/fallbacks (DRY — normalizeOperatorBrainPlanResult and the operator fallbacks are
// surface-validation machinery, agent-agnostic), and executeVizMasterPlan is a thin pass-through
// to the SHARED executor with actor:"viz-master" (the G2 ownership seam). viz-master only ever
// emits chart-family steps; no agent-feasibility pre-flight is needed (charts reference no agents).

import { planWithVizMasterBrain } from "./viz-master-brain.js";
import { executeOperatorExecutablePlan } from "../operator/operator-executor.js";
import {
  buildOperatorAdviceFallback,
  buildOperatorInvalidPlanFallback,
} from "../operator-fallback.js";
import { normalizeOperatorBrainPlanResult } from "../operator/operator-plan.js";
import { normalizeString } from "../core/normalize.js";

export async function buildVizMasterPlan({
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
    brainResult = await planWithVizMasterBrain({
      message: requestText,
      history,
      currentPlan,
      logger,
    });
  } catch (error) {
    // Same split as operator-runtime: unparseable JSON (planner output bug) → invalid-plan fallback;
    // brain truly unavailable (network/provider) → advice-only fallback. Reuses the operator fallbacks
    // (they are surface-agnostic plan-response builders, not operator-specific behavior).
    if (error?.code === "PLANNER_JSON_PARSE_FAILED") {
      logger?.warn?.(`[watchdog] viz-master-brain returned unparseable JSON, invalid-plan fallback: ${error.message}`);
      return buildOperatorInvalidPlanFallback({ requestText, error, brainResult: null });
    }
    const cause = error?.cause ? ` | cause: ${error.cause.code || error.cause.message || error.cause}` : "";
    logger?.warn?.(`[watchdog] viz-master-brain unavailable, advice-only fallback: ${error.message}${cause}`);
    return buildOperatorAdviceFallback({ requestText, error });
  }

  try {
    return normalizeOperatorBrainPlanResult(brainResult, requestText);
  } catch (error) {
    logger?.warn?.(`[watchdog] viz-master-brain produced invalid plan, advice-only fallback: ${error.message}`);
    return buildOperatorInvalidPlanFallback({ requestText, error, brainResult });
  }
}

export async function executeVizMasterPlan({
  plan,
  logger = null,
  onAlert = null,
  runtimeContext = null,
  dryRun = false,
  forceVerify = true,
  explicitConfirm = false,
  delegateDepth = 0,
} = {}) {
  return executeOperatorExecutablePlan({
    plan,
    logger,
    onAlert,
    runtimeContext,
    dryRun,
    forceVerify,
    explicitConfirm,
    delegateDepth,
    // G2 actor seam: assertActorOwnsSurface(viz-master, ...) permits only the chart family + shared
    // verify infra. A non-chart step a misbehaving planner smuggled in is rejected at the executor.
    actor: "viz-master",
  });
}
