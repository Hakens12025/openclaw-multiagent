import { inspectCliSystemGraphState } from "../cli-system/cli-graph-inspector.js";
import { executeCliSystemSurface } from "../cli-system/cli-surface-registry.js";
import { runVerifyAfterApply } from "../cli-system/cli-surface-verify-gate.js";
import { normalizeOperatorPlan } from "./operator-plan.js";

export async function executeOperatorExecutablePlan({
  plan,
  logger = null,
  onAlert = null,
  runtimeContext = null,
  dryRun = false,
  forceVerify = true,
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

  const results = [];
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

  return {
    ok: true,
    dryRun: false,
    executedAt: Date.now(),
    summary: normalizedPlan.summary,
    plan: normalizedPlan,
    results,
    graph: await inspectCliSystemGraphState(),
  };
}
