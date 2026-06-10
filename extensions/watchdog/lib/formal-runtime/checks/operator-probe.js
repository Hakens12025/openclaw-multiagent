// lib/formal-runtime/checks/operator-probe.js — operator 套件的纯逻辑层（零 IO，可单测）
//
// 手写计划（不走 LLM）+ 响应判读。事实依据（写死前已核对真实代码）：
// - graph.edge.add 在 UNSUPPORTED_VERIFICATION_SURFACES 里（plan-hints/meta.js）→ verify 豁免，
//   所以强制 verify 门的探针步用 schedules.create（verificationCapability.supported=true）。
// - schedules.delete confirmation="explicit" → C2 负探针（不带 explicitConfirm 必须被拒）。
// - operator/plan 不可用时不抛 —— 返回 advice_only 兜底，plan.derived.reason 区分
//   "operator_brain_unavailable"（→ skip）与 "operator_plan_validation_failed"（→ fail）。

// 探针 plan：一条低风险 graph 边（用后即删）+ 一条 disabled schedule（触发 verify 门，用后即删）。
export function buildOperatorApplyProbePlan({ edgeFrom, edgeTo, scheduleId }) {
  return {
    intent: "platform_mutation",
    summary: "formal operator probe: temp edge + disabled schedule",
    steps: [
      {
        surfaceId: "graph.edge.add",
        title: "add temp probe edge",
        payload: { from: edgeFrom, to: edgeTo, label: "formal-operator-probe" },
      },
      {
        surfaceId: "schedules.create",
        title: "create disabled probe schedule",
        payload: {
          scheduleId,
          label: "formal operator probe (disabled, auto-removed)",
          enabled: false,
          trigger: { kind: "cron", cron: "0 5 * * *" },
        },
      },
    ],
  };
}

// dryRun 探针 plan：单步 edge.add（dryRun:true 必须零副作用）。
export function buildOperatorDryRunProbePlan({ edgeFrom, edgeTo }) {
  return {
    intent: "graph_mutation",
    summary: "formal operator dry-run probe",
    steps: [
      {
        surfaceId: "graph.edge.add",
        title: "dry-run temp probe edge",
        payload: { from: edgeFrom, to: edgeTo, label: "formal-operator-probe" },
      },
    ],
  };
}

// C2 负探针 plan：破坏性 surface（schedules.delete）但目标 id 不存在 —— 即使闸坏了也无实害。
export function buildOperatorDestructiveProbePlan(scheduleId = "formal-nonexistent-probe") {
  return {
    intent: "platform_mutation",
    summary: "formal operator destructive-confirm probe",
    steps: [
      {
        surfaceId: "schedules.delete",
        title: "delete (refused without explicitConfirm)",
        payload: { scheduleId },
      },
    ],
  };
}

// 强制 verify 门元数据判读：apply 响应的 verifications[] 至少一条 required=true 且
// presetId 非空、status ∈ started|failed_to_start（套件自身就是 active test run，
// test_runs.start 拒绝并发 → failed_to_start 在 run 内属预期，证明的是「门触发了」）。
export function evaluateVerifyGateMetadata(verifications) {
  const list = Array.isArray(verifications) ? verifications : [];
  const fired = list.filter((v) => v && v.required === true
    && typeof v.presetId === "string" && v.presetId.trim()
    && ["started", "failed_to_start"].includes(v.status));
  const summary = list.map((v) => `${v?.surfaceId || "?"}:${v?.status || "?"}(preset=${v?.presetId || "-"})`).join("; ");
  if (fired.length === 0) {
    return { ok: false, evidence: `no forced-verify metadata in apply response; verifications=[${summary}]` };
  }
  return {
    ok: true,
    evidence: `verify gate fired: [${summary}]`
      + (fired.some((v) => v.status === "failed_to_start")
        ? " (failed_to_start is expected inside an active test run: test_runs.start rejects concurrent launches)"
        : ""),
  };
}

// operator/plan 响应分类：plan | provider_down | invalid。
export function classifyOperatorPlanResponse(body) {
  const reason = body?.plan?.derived?.reason || null;
  const steps = Array.isArray(body?.plan?.steps) ? body.plan.steps : [];
  if (reason === "operator_brain_unavailable") {
    return { outcome: "provider_down", evidence: `planner provider unreachable: ${(body?.plan?.warnings || []).join("; ") || "advice_only fallback"}` };
  }
  if (steps.length > 0) {
    return {
      outcome: "plan",
      evidence: `intent=${body?.intent || "?"} steps=[${steps.map((s) => s?.surfaceId).join(", ")}] canExecute=${body?.canExecute === true}`,
    };
  }
  return {
    outcome: "invalid",
    evidence: `planner produced no executable steps (reason=${reason || "none"}; reply=${String(body?.reply || "").slice(0, 120)})`,
  };
}
