import { inspectCliSystemGraphState } from "../cli-system/cli-graph-inspector.js";
import { executeCliSystemSurface, getCliSystemSurface } from "../cli-system/cli-surface-registry.js";
import { runPlanVerificationsAfterApply } from "../cli-system/cli-surface-verify-gate.js";
import { captureStructureSnapshot, restoreStructureSnapshot } from "../control-plane/structure-snapshot.js";
import { assertOperatorPlanAgentFeasibility, normalizeOperatorPlan } from "./operator-plan.js";

// Meta→meta delegation registry: a delegatable meta-agent id → a loader for its runtime
// { build, execute } pair. ONE row per meta-agent (data, not an `if (id===...)` branch); the
// dynamic import is deferred inside the loader so there is no operator-executor ↔ runtime import
// cycle. This is operator's executor invoking another meta-agent's brain as an IN-PROCESS function
// call (R2) — not the worker conveyor belt, not a graph edge, not dispatch.
const META_AGENT_DELEGATES = Object.freeze({
  "viz-master": async () => {
    const m = await import("../viz/viz-master-runtime.js");
    return { build: m.buildVizMasterPlan, execute: m.executeVizMasterPlan };
  },
});

// Run a meta.delegate step: the target meta-agent plans its own sub-task (its own LLM brain) and
// executes under its OWN actor, so its ownership backstop confines what it may write. Returns the
// sub-plan's result ({ ok, ... }); a non-executable sub-plan (advice-only) is surfaced as ok:false.
async function runMetaDelegate(payload, { logger, onAlert, runtimeContext, explicitConfirm, delegateDepth }) {
  const targetActor = payload?.targetActor;
  const loadDelegate = META_AGENT_DELEGATES[targetActor];
  if (!loadDelegate) {
    return { ok: false, error: `meta.delegate: unknown target meta-agent "${targetActor}"` };
  }
  const { build, execute } = await loadDelegate();
  const planned = await build({ message: payload.request, logger });
  if (!planned?.plan?.steps?.length) {
    return { ok: false, error: planned?.plan?.reply || planned?.reply || `${targetActor} produced no executable plan` };
  }
  // Thread the parent's confirmation (NOT a hardcoded true) + one more delegation hop. A future
  // delegate owning a destructive (confirmation:"explicit") surface must still require the human
  // confirm the parent carried, never auto-approve it.
  return execute({ plan: planned.plan, explicitConfirm, delegateDepth: delegateDepth + 1, logger, onAlert, runtimeContext });
}

export async function executeOperatorExecutablePlan({
  plan,
  logger = null,
  onAlert = null,
  runtimeContext = null,
  dryRun = false,
  forceVerify = true,
  explicitConfirm = false,
  actor = "operator",
  delegateDepth = 0,
} = {}) {
  const normalizedPlan = normalizeOperatorPlan(plan);

  // E2 — feasibility pre-flight: reject a plan whose graph/group steps reference an agent that
  // neither already exists nor is created by an earlier step in the SAME plan (dangling edge → half-apply).
  // Runs BEFORE the dryRun return so a PREVIEW also surfaces infeasibility (not only the live execute path).
  await assertOperatorPlanAgentFeasibility(normalizedPlan);

  if (dryRun === true) {
    return {
      ok: true,
      dryRun: true,
      summary: normalizedPlan.summary,
      plan: normalizedPlan,
      graph: await inspectCliSystemGraphState(),
    };
  }

  // C2 — suggest-only boundary: refuse to auto-run explicit-confirmation (destructive) surfaces
  // unless the human explicitly confirmed. Pre-flight BEFORE applying any step, so a destructive
  // op never half-executes a plan — matches the gate the direct admin routes enforce.
  const needsConfirm = normalizedPlan.steps.filter(
    (step) => getCliSystemSurface(step.surfaceId)?.confirmation === "explicit",
  );
  if (needsConfirm.length > 0 && explicitConfirm !== true) {
    return {
      ok: false,
      blocked: "explicit_confirmation_required",
      summary: normalizedPlan.summary,
      plan: normalizedPlan,
      requiresExplicitConfirm: needsConfirm.map((step) => ({ surfaceId: step.surfaceId, title: step.title })),
    };
  }

  // E1 — atomic apply boundary for MULTI-STEP plans: capture a structure snapshot before the first
  // mutation so a mid-plan throw can be rolled back. Single-step plans can't half-apply, so skip the
  // capture (avoids polluting the snapshot ring + withLock latency on trivial/safe plans). Reuses the
  // existing structure-snapshot mechanism — no second snapshot system.
  let rollbackSnapshotId = null;
  if (normalizedPlan.steps.length > 1) {
    try {
      const snap = await captureStructureSnapshot({
        reason: `operator-apply:${normalizedPlan.summary || "plan"}`,
        label: "operator-pre-apply",
      });
      rollbackSnapshotId = snap?.id || null;
    } catch (snapError) {
      logger?.warn?.(`[watchdog] operator pre-apply snapshot skipped: ${snapError.message}`);
    }
  }

  const results = [];
  try {
    for (const step of normalizedPlan.steps) {
      if (step.surfaceId === "meta.delegate") {
        // R2 in-process delegation: operator summons the owning meta-agent's brain+executor as a
        // function call. The sub-plan runs under the TARGET actor (its ownership backstop confines
        // it). A sub-failure throws → rolls back exactly like any other step throw below.
        // OPERATOR-ONLY + one-hop, as STRUCTURAL guarantees (not prompt convention): a delegated
        // sub-plan runs under its target's actor and must never re-delegate (no lateral escalation,
        // no recursion). The depth guard bounds it even if the actor gate is ever loosened.
        if (actor !== "operator") {
          throw new Error(`meta.delegate is operator-only (actor=${actor})`);
        }
        if (delegateDepth >= 1) {
          throw new Error("meta.delegate depth limit reached (one hop)");
        }
        const delegated = await runMetaDelegate(step.payload, { logger, onAlert, runtimeContext, explicitConfirm, delegateDepth });
        if (delegated && delegated.ok === false) {
          throw new Error(typeof delegated.error === "string" && delegated.error ? delegated.error : `meta.delegate to ${step.payload?.targetActor} failed`);
        }
        results.push({ surfaceId: step.surfaceId, title: step.title, summary: step.summary, payload: step.payload, result: delegated });
        continue;
      }
      const result = await executeCliSystemSurface({
        surfaceId: step.surfaceId,
        payload: step.payload,
        actor,
        logger,
        onAlert,
        runtimeContext,
      });
      // P1 — a SOFT failure ({ok:false}, e.g. skills.create on an existing skill returns ok:false
      // WITHOUT throwing) must not be silently recorded as success: throw so it hits the same rollback
      // path a thrown error would, instead of leaving a half-applied plan reporting top-level ok:true.
      if (result && result.ok === false) {
        throw new Error(typeof result.error === "string" && result.error ? result.error : `operator step ${step.surfaceId} reported failure`);
      }
      results.push({
        surfaceId: step.surfaceId,
        title: step.title,
        summary: step.summary,
        payload: step.payload,
        result,
      });
    }
  } catch (stepError) {
    // A step threw mid-plan: stop, roll the structure back to the pre-apply snapshot (if captured),
    // and return a STRUCTURED failure instead of re-throwing — so the route returns a readable body
    // (which step failed + what was applied + rollback outcome), not an opaque 400 with a half-mutated system.
    const failedStepIndex = results.length;
    const failedSurfaceId = normalizedPlan.steps[failedStepIndex]?.surfaceId || null;
    const rollback = rollbackSnapshotId
      ? await restoreStructureSnapshot(rollbackSnapshotId).catch((e) => ({ ok: false, error: e.message }))
      : { ok: false, error: "no pre-apply snapshot was captured" };
    return {
      ok: false,
      error: stepError.message,
      failedStepIndex,
      failedSurfaceId,
      appliedResults: results,
      rollback,
      summary: normalizedPlan.summary,
      plan: normalizedPlan,
    };
  }

  // ② forced verify — run ONCE per unique (preset,cleanMode) across the WHOLE plan, AFTER all steps
  // apply (not per-step). A verify run is a full system suite that validates the resulting state, and
  // startTestRun rejects a concurrent launch — per-step would make every step after the first report
  // failed_to_start. runPlanVerificationsAfterApply dedupes; today all apply surfaces share preset
  // "single" → exactly one verify per plan. Reads/launches verify only; never touches the gate itself.
  const verifications = await runPlanVerificationsAfterApply({
    surfaceIds: normalizedPlan.steps.map((step) => step.surfaceId),
    logger,
    onAlert,
    runtimeContext,
    forceVerify,
  });

  // E3 — surface the verify outcome at plan level so operator chat can warn if a required verify could
  // not even be launched (status "failed_to_start").
  const failedVerifications = verifications.filter((v) => v?.status === "failed_to_start");
  const verificationSummary = {
    total: verifications.length,
    failedToStart: failedVerifications.length,
    anyFailedToStart: failedVerifications.length > 0,
    failedSurfaceIds: failedVerifications.map((v) => v.surfaceId),
  };

  return {
    ok: true,
    dryRun: false,
    executedAt: Date.now(),
    summary: normalizedPlan.summary,
    plan: normalizedPlan,
    results,
    verifications,
    verificationSummary,
    graph: await inspectCliSystemGraphState(),
  };
}
