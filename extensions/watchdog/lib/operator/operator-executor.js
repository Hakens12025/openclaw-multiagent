import { inspectCliSystemGraphState } from "../cli-system/cli-graph-inspector.js";
import { executeCliSystemSurface, getCliSystemSurface } from "../cli-system/cli-surface-registry.js";
import { runVerifyAfterApply } from "../cli-system/cli-surface-verify-gate.js";
import { captureStructureSnapshot, restoreStructureSnapshot } from "../control-plane/structure-snapshot.js";
import { assertOperatorPlanAgentFeasibility, normalizeOperatorPlan } from "./operator-plan.js";

export async function executeOperatorExecutablePlan({
  plan,
  logger = null,
  onAlert = null,
  runtimeContext = null,
  dryRun = false,
  forceVerify = true,
  explicitConfirm = false,
} = {}) {
  const normalizedPlan = normalizeOperatorPlan(plan);

  if (dryRun === true) {
    return {
      ok: true,
      dryRun: true,
      summary: normalizedPlan.summary,
      plan: normalizedPlan,
      graph: await inspectCliSystemGraphState(),
    };
  }

  // E2 — feasibility pre-flight: reject a plan whose graph/loop/group steps reference an agent that
  // neither already exists nor is created by an earlier step in the SAME plan (dangling edge → half-apply).
  // Runs after dryRun (so a dry-run still previews infeasible plans) and before any mutation.
  await assertOperatorPlanAgentFeasibility(normalizedPlan);

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
      const result = await executeCliSystemSurface({
        surfaceId: step.surfaceId,
        payload: step.payload,
        actor: "operator",
        logger,
        onAlert,
        runtimeContext,
      });
      // ② 强制 verify 门（forceVerify after apply）：apply 成功后，若该 surface 有
      // verificationCapability.supported，平台强制启动一道 verify 把改动验回来（不靠自觉）。
      // 与 P3 commit 门互补——同一套 verify 机制的 operator 主动 apply 插入点。
      const verification = await runVerifyAfterApply({
        surfaceId: step.surfaceId,
        logger,
        onAlert,
        runtimeContext,
        forceVerify,
      });
      results.push({
        surfaceId: step.surfaceId,
        title: step.title,
        summary: step.summary,
        payload: step.payload,
        result,
        verification,
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

  // E3 — surface the verify outcome at plan level. runVerifyAfterApply returns status
  // "failed_to_start" when a required verify could not even be launched; aggregate it so the
  // caller (operator chat) can warn the user the change was NOT verified. Reads verification
  // results only — it never touches the forceVerify gate (#37) mechanism itself.
  const requiredVerifications = results.filter((r) => r.verification?.required === true);
  const failedVerifications = requiredVerifications.filter((r) => r.verification?.status === "failed_to_start");
  const verificationSummary = {
    total: requiredVerifications.length,
    failedToStart: failedVerifications.length,
    anyFailedToStart: failedVerifications.length > 0,
    failedSurfaceIds: failedVerifications.map((r) => r.surfaceId),
  };

  return {
    ok: true,
    dryRun: false,
    executedAt: Date.now(),
    summary: normalizedPlan.summary,
    plan: normalizedPlan,
    results,
    verificationSummary,
    graph: await inspectCliSystemGraphState(),
  };
}
