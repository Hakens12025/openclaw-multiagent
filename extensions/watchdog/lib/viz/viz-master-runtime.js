// viz-master-runtime.js — the runtime entrypoint for the visualization master meta-agent.
// Mirrors operator-runtime.js: buildVizMasterPlan wraps the viz brain + the SHARED plan
// normalizer/fallbacks (DRY — normalizeOperatorBrainPlanResult and the operator fallbacks are
// surface-validation machinery, agent-agnostic), and executeVizMasterPlan is a thin pass-through
// to the SHARED executor with actor:"viz-master" (the G2 ownership seam). viz-master only ever
// emits chart-family steps; no agent-feasibility pre-flight is needed (charts reference no agents).

import { planWithVizMasterBrain } from "./viz-master-brain.js";
import {
  buildControlMessage,
  buildControlShape,
  deriveChartNarrative,
  diffSpecAgainstDataset,
  extractSpecFromPlan,
  generateControlDataset,
} from "./chart-verification.js";
import {
  validateChartSpec,
  STATIC_MAX_SERIES,
  STATIC_MAX_POINTS_PER_SERIES,
} from "./chart-spec-schema.js";
import { executeOperatorExecutablePlan } from "../operator/operator-executor.js";
import {
  buildOperatorAdviceFallback,
  buildOperatorInvalidPlanFallback,
} from "../operator/operator-fallback.js";
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

// verifyVizMasterPlan — the accept-stage 防伪对照 orchestrator. The narrative is derived by
// CODE from the real spec (the LLM never writes it), and 3 SAME-SHAPE synthetic controls are
// sent through the SAME transcription channel (planFn) in parallel, each judged by CODE against
// its code-generated ground truth — viz-master never self-certifies. Read+LLM only: nothing
// here persists anything; controls are never stored. planFn is the injectable test seam
// (same DI pattern as wiki-rag-eval's searchFn).
export async function verifyVizMasterPlan({ plan, logger = null, planFn = buildVizMasterPlan } = {}) {
  const rawSpec = extractSpecFromPlan(plan);
  if (!rawSpec) {
    return { ok: false, error: "plan has no chart step" };
  }

  // Validate + normalize BEFORE deriving anything: a malformed spec (e.g. series-less) must
  // fail closed here instead of feeding empty arrays into the narrative/shape derivations.
  let spec;
  try {
    spec = validateChartSpec(rawSpec);
  } catch (error) {
    return { ok: false, error: `图表 spec 无效，无法对照: ${error?.message || error}` };
  }

  const narrative = deriveChartNarrative(spec);
  const shape = buildControlShape(spec);
  // Verify-cost bound: validateChartSpec already caps series/points upstream, but keep an
  // explicit shape bound so the 3× control fan-out can never be driven past 10×200.
  if (shape.seriesCount > STATIC_MAX_SERIES || shape.pointCounts.some((count) => count > STATIC_MAX_POINTS_PER_SERIES)) {
    return { ok: false, error: `图表规模超出对照上限（最多 ${STATIC_MAX_SERIES} 个系列、每系列 ${STATIC_MAX_POINTS_PER_SERIES} 个点）` };
  }

  const datasets = [0, 1, 2].map((index) => generateControlDataset(shape, index));
  // Build each control message exactly ONCE — the datasetText displayed to the human is by
  // construction the SAME string fed to planFn (displayed == fed).
  const messages = datasets.map((dataset) => buildControlMessage(dataset, shape.type));

  // Promise.allSettled: one control's failure must not kill the other two.
  const settled = await Promise.allSettled(
    messages.map((message) => planFn({ message, logger })),
  );

  const controls = settled.map((outcome, index) => {
    const dataset = datasets[index];
    const datasetText = messages[index];
    if (outcome.status === "rejected") {
      const reason = normalizeString(outcome.reason?.message) || String(outcome.reason);
      return { datasetText, spec: null, verdict: { pass: false, mismatches: [`对照请求失败: ${reason}`] } };
    }
    const controlSpec = extractSpecFromPlan(outcome.value?.plan);
    if (!controlSpec) {
      return { datasetText, spec: null, verdict: { pass: false, mismatches: ["对照计划没有产出图表步骤"] } };
    }
    if (controlSpec.type !== shape.type) {
      return {
        datasetText,
        spec: controlSpec,
        verdict: { pass: false, mismatches: [`图类型: 期望 ${shape.type}, 实得 ${controlSpec.type}`] },
      };
    }
    return { datasetText, spec: controlSpec, verdict: diffSpecAgainstDataset(controlSpec, dataset) };
  });

  return {
    ok: true,
    narrative,
    controls,
    summary: {
      passed: controls.filter((control) => control.verdict.pass).length,
      total: controls.length,
    },
  };
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
