import { planWithOperatorBrain } from "./operator-brain.js";
import { executeOperatorExecutablePlan } from "./operator-executor.js";
import {
  buildOperatorAdviceFallback,
  buildOperatorInvalidPlanFallback,
} from "./operator-fallback.js";
import { collectOperatorPlanInfeasibilities, normalizeOperatorBrainPlanResult } from "./operator-plan.js";
import { normalizeString } from "../core/normalize.js";

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
    // Distinguish "model responded but its JSON was unparseable" (invalid-plan) from
    // "brain truly unavailable" (network/provider). Conflating them mislabels a planner
    // output bug as an outage — see lib/llm-planner.js parsePlannerJson.
    if (error?.code === "PLANNER_JSON_PARSE_FAILED") {
      logger?.warn?.(`[watchdog] operator-brain returned unparseable JSON, invalid-plan fallback: ${error.message}`);
      return buildOperatorInvalidPlanFallback({ requestText, error, brainResult: null });
    }
    // Surface the underlying cause (undici hides connection/TLS/body errors behind "fetch failed").
    const cause = error?.cause ? ` | cause: ${error.cause.code || error.cause.message || error.cause}` : "";
    logger?.warn?.(`[watchdog] operator-brain unavailable, advice-only fallback: ${error.message}${cause}`);
    return buildOperatorAdviceFallback({
      requestText,
      error,
    });
  }

  try {
    const response = normalizeOperatorBrainPlanResult(brainResult, requestText);
    // E2b — canExecute must reflect feasibility at PLAN-BUILD, not only at execute-time. If the plan
    // references an agent that neither exists nor is created earlier in the same plan, executing it
    // would fail the feasibility pre-flight (operator-executor) — so don't advertise EXECUTE as
    // available. Downgrade canExecute + tell the user what's missing. Graceful if the registry read
    // fails (keep canExecute as-is rather than block a good plan on a transient error).
    if (response?.canExecute && Array.isArray(response?.plan?.steps) && response.plan.steps.length > 0) {
      try {
        const infeasible = await collectOperatorPlanInfeasibilities(response.plan);
        if (infeasible.length > 0) {
          const missing = [...new Set(infeasible.map((f) => f.missingAgentId))];
          response.canExecute = false;
          response.plan.limitations = [...new Set([
            ...(Array.isArray(response.plan.limitations) ? response.plan.limitations : []),
            `计划引用了尚不存在的 agent：${missing.join("、")}。请在同一计划里先用 agents.create 建好，或先单独创建这些 agent 再执行。`,
          ])];
          response.plan.derived = { ...(response.plan.derived || {}), feasibilityBlocked: true, missingAgents: missing };
        }
      } catch (feasibilityError) {
        logger?.warn?.(`[watchdog] operator plan feasibility check skipped: ${feasibilityError.message}`);
      }
    }
    return response;
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
  forceVerify = true,
  explicitConfirm = false,
} = {}) {
  return executeOperatorExecutablePlan({
    plan,
    logger,
    onAlert,
    runtimeContext,
    dryRun,
    // ② 强制 verify 门默认开（评审要的「强制」）；可经调用方/config 显式关。
    forceVerify,
    // C2 — 显式确认才放行破坏性(confirmation:explicit)surface；默认 false = 建议态拒绝执行。
    explicitConfirm,
  });
}
