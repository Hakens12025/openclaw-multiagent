import test, { mock } from "node:test";
import assert from "node:assert/strict";

// ② forceVerify after apply：operator 主动 apply 路径焊上 verify 门。
// 与 P3 commit 门互补——同一套 verify 机制（verificationCapability + test_runs.start +
// 既有状态语义），不造第二套真值。
//
// 隔离策略：先注册终端 sink mock（executeAdminSurfaceOperation，apply 与 verify-start 都经它），
// 再动态 import 受测模块——确保 cli-surface-executor 绑定的是 mock 后的 sink，
// 让真实 cli-surface-executor 四道门 + 真实 catalog 跑，只挡住会真跑 test 的底层操作。

// 保留真实兄弟导出（registry 需要 hasAdminSurfaceOperationHandler/getAdminSurfaceOperationHandler
// 来算 executable），只覆盖终端 executeAdminSurfaceOperation。
import {
  getAdminSurfaceOperationHandler,
  hasAdminSurfaceOperationHandler,
} from "../lib/admin/admin-surface-operations.js";

const sinkCalls = [];
let failVerifyStart = false;
mock.module("../lib/admin/admin-surface-operations.js", {
  namedExports: {
    hasAdminSurfaceOperationHandler,
    getAdminSurfaceOperationHandler,
    executeAdminSurfaceOperation: async ({ surfaceId, payload, runtimeContext }) => {
      sinkCalls.push({ surfaceId, payload, runtimeContext });
      if (surfaceId === "test_runs.start") {
        if (failVerifyStart) throw new Error("verify runner unavailable");
        return { ok: true, run: { id: "tr-forced-1", status: "queued", presetId: payload?.presetId } };
      }
      return { ok: true, applied: true };
    },
  },
});

mock.module("../lib/cli-system/cli-graph-inspector.js", {
  namedExports: { inspectCliSystemGraphState: async () => ({ edges: [] }) },
});

const { isVerifyRequiredAfterApply, runVerifyAfterApply } = await import("../lib/cli-system/cli-surface-verify-gate.js");
const { executeOperatorExecutablePlan } = await import("../lib/operator/operator-executor.js");

// ── 门判定（纯函数，真 surface catalog）────────────────────────────────────────

test("verify is required after apply only for surfaces with verificationCapability.supported", () => {
  assert.equal(isVerifyRequiredAfterApply("agents.policy"), true);
  assert.equal(isVerifyRequiredAfterApply("graph.edge.add"), false, "graph.edge.add exempt");
  assert.equal(isVerifyRequiredAfterApply("runtime.reset"), false, "runtime.reset exempt");
  assert.equal(isVerifyRequiredAfterApply("test_runs.start"), false, "verify surface itself exempt (no self-loop)");
});

test("forceVerify=false opts out of the gate (configurable but default-on)", () => {
  assert.equal(isVerifyRequiredAfterApply("agents.policy", { forceVerify: false }), false);
});

// ── 门执行 + 焊入 operator 主动 apply 路径 ─────────────────────────────────────

test("runVerifyAfterApply forcibly starts verify for a supported apply surface", async () => {
  sinkCalls.length = 0;
  failVerifyStart = false;
  const v = await runVerifyAfterApply({ surfaceId: "agents.policy" });
  assert.equal(v.required, true);
  assert.equal(v.status, "started", "verify is forcibly kicked off after apply");
  assert.equal(v.verifySurfaceId, "test_runs.start", "reuses the P3 verify surface");
  assert.equal(v.presetId, "dispatch", "uses the surface's verificationCapability preset");
  assert.equal(v.run?.id, "tr-forced-1");
  const verifyCall = sinkCalls.find((c) => c.surfaceId === "test_runs.start");
  assert.equal(verifyCall.runtimeContext.originSurfaceId, "agents.policy", "verify origin links back to apply surface");
});

test("runVerifyAfterApply exempts surfaces without verificationCapability (honest exempt list)", async () => {
  sinkCalls.length = 0;
  const v = await runVerifyAfterApply({ surfaceId: "graph.edge.add" });
  assert.equal(v.required, false);
  assert.equal(v.status, "exempt");
  assert.equal(sinkCalls.filter((c) => c.surfaceId === "test_runs.start").length, 0, "no verify started for exempt surface");
});

test("verify-start failure is recorded as failed_to_start, never silently passed", async () => {
  sinkCalls.length = 0;
  failVerifyStart = true;
  const v = await runVerifyAfterApply({ surfaceId: "agents.policy" });
  assert.equal(v.required, true);
  assert.equal(v.status, "failed_to_start", "must NOT be marked verified-success when verify cannot run");
  assert.match(v.error, /verify runner unavailable/);
  failVerifyStart = false;
});

test("operator active-apply plan runs ONE forced verify for the plan (supported surface)", async () => {
  sinkCalls.length = 0;
  failVerifyStart = false;
  const out = await executeOperatorExecutablePlan({
    plan: {
      intent: "platform_mutation",
      summary: "force-verify e2e",
      steps: [
        { surfaceId: "agents.policy", title: "policy", summary: "change policy", payload: { agentId: "a1" } },
      ],
    },
  });

  assert.equal(out.ok, true);
  // verify is plan-level (one run per unique preset), not per-step.
  assert.equal(out.verifications.length, 1, "one forced verify for the plan");
  assert.equal(out.verifications[0].required, true);
  assert.equal(out.verifications[0].status, "started", "supported apply forces a verify");
  // apply + verify(test_runs.start) 各一次经终端 sink
  assert.equal(sinkCalls.filter((c) => c.surfaceId === "agents.policy").length, 1, "apply executed once");
  assert.equal(sinkCalls.filter((c) => c.surfaceId === "test_runs.start").length, 1, "verify forced once after apply");
});

// The bug behind "applied but verify failed 1/2": per-step verify fired one test_runs.start PER step,
// but startTestRun rejects a concurrent run (test-runs.js: "another test run is already active"), so
// step 2+ always reported failed_to_start. Verify now runs ONCE per unique preset for the whole plan —
// a multi-step plan launches a single test_runs.start, with NO false failed_to_start.
test("multi-step plan launches ONE forced verify (deduped by preset), not one per step", async () => {
  sinkCalls.length = 0;
  failVerifyStart = false;
  const out = await executeOperatorExecutablePlan({
    plan: {
      intent: "platform_mutation",
      summary: "multi-step force-verify",
      steps: [
        { surfaceId: "agents.policy", title: "p1", summary: "change a1", payload: { agentId: "a1" } },
        { surfaceId: "agents.policy", title: "p2", summary: "change a2", payload: { agentId: "a2" } },
      ],
    },
  });

  assert.equal(out.ok, true);
  assert.equal(sinkCalls.filter((c) => c.surfaceId === "agents.policy").length, 2, "both applies ran");
  assert.equal(sinkCalls.filter((c) => c.surfaceId === "test_runs.start").length, 1, "verify launched ONCE, not per step");
  assert.deepEqual(out.verificationSummary, { total: 1, failedToStart: 0, anyFailedToStart: false, failedSurfaceIds: [] });
});

test("operator plan with forceVerify=false skips the gate (configurable)", async () => {
  sinkCalls.length = 0;
  const out = await executeOperatorExecutablePlan({
    plan: {
      intent: "platform_mutation",
      summary: "no-verify",
      steps: [{ surfaceId: "agents.policy", title: "policy", summary: "change", payload: { agentId: "a1" } }],
    },
    forceVerify: false,
  });
  assert.equal(out.verifications.length, 0, "no forced verify when opted out");
  assert.equal(out.verificationSummary.total, 0);
  assert.equal(sinkCalls.filter((c) => c.surfaceId === "test_runs.start").length, 0, "no forced verify when opted out");
});

// E3 — a verify that FAILS to start must surface at plan level (verificationSummary), so the operator
// chat can warn the user the change was applied-but-NOT-verified (instead of an ok:true silence).
test("operator plan exposes verificationSummary when a forced verify fails to start", async () => {
  sinkCalls.length = 0;
  failVerifyStart = true;
  const out = await executeOperatorExecutablePlan({
    plan: {
      intent: "platform_mutation",
      summary: "verify-surface e2e",
      steps: [{ surfaceId: "agents.policy", title: "policy", summary: "change", payload: { agentId: "a1" } }],
    },
  });
  failVerifyStart = false;
  assert.equal(out.ok, true, "apply still succeeds; only verify failed to start");
  assert.deepEqual(out.verificationSummary, {
    total: 1,
    failedToStart: 1,
    anyFailedToStart: true,
    failedSurfaceIds: ["agents.policy"],
  });
});
