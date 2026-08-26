// 起跑判据真值（L8 调度·自动化）：
// ① 派工失败(ingress `{ok:false, contractId, error}`)不得记成起跑成功——否则 runtime 停在
//    status:"running"，reconcile 因该 PENDING 合约仍 active 持续判 running，executor 只在 idle
//    起跑 → 永久卡死；
// ② 起跑失败必须留下**有限**的 nextWakeAt（退避），否则 executor 的
//    `Number.isFinite(nextWakeAt)` 门永远不开，automation 静默停摆。
import test from "node:test";
import assert from "node:assert/strict";

import { deleteAutomationSpec, upsertAutomationSpec } from "../lib/automation/automation-registry.js";
import { deleteAutomationRuntimeState } from "../lib/automation/automation-runtime.js";
import { classifyStartResult } from "../lib/automation/automation-round-context.js";
import { startAutomationRound } from "../lib/automation/automation-executor.js";

function buildLogger() {
  return { info() {}, warn() {}, error() {} };
}

const COOLDOWN_SECONDS = 60;

async function withAutomation(automationId, run) {
  await upsertAutomationSpec({
    id: automationId,
    objective: {
      summary: "start failure truth",
      instruction: "verify start criteria",
      domain: "coding",
    },
    entry: { targetAgent: "controller" },
    wakePolicy: { type: "result", onResult: true, cooldownSeconds: COOLDOWN_SECONDS },
    systemActionDelivery: { agentId: "controller" },
  });
  try {
    return await run();
  } finally {
    await deleteAutomationRuntimeState(automationId).catch(() => {});
    await deleteAutomationSpec(automationId).catch(() => {});
  }
}

test("classifyStartResult treats an ingress failure carrying a contractId as NOT started", () => {
  const failed = classifyStartResult({
    ok: false,
    contractId: "TC-DISPATCH-FAILED",
    error: "dispatch_failed",
    targetAgent: "worker",
  });
  assert.equal(failed.started, false, "ok:false must not count as a start even with a contract minted");
  assert.equal(failed.reason, "dispatch_failed", "the ingress error is the start-failure reason");
  assert.equal(failed.contractId, "TC-DISPATCH-FAILED");
});

test("classifyStartResult still counts a successful ingress dispatch as started", () => {
  assert.equal(classifyStartResult({ ok: true, contractId: "TC-OK" }).started, true);
  // 无 ok 字段（老形状/测试替身）保持起跑语义，不因加严而误判停摆
  assert.equal(classifyStartResult({ contractId: "TC-NO-OK-FIELD" }).started, true);
  assert.equal(classifyStartResult({ ok: true }).started, false, "no contract minted = no start");
});

test("a failed dispatch leaves the automation idle with a finite backoff wake time", async () => {
  const automationId = `automation-start-failure-${Date.now()}`;
  await withAutomation(automationId, async () => {
    const before = Date.now();
    const result = await startAutomationRound(automationId, {
      api: {},
      logger: buildLogger(),
      dispatchAcceptIngressMessageFn: async () => ({
        ok: false,
        contractId: "TC-AUTOMATION-DISPATCH-FAILED",
        error: "dispatch_failed",
        targetAgent: "worker",
      }),
    });

    assert.equal(result.skipped, true, "a failed dispatch is not a started round");
    assert.equal(result.reason, "dispatch_failed");
    const runtime = result.runtime;
    assert.equal(runtime.status, "idle", "status must fall back to idle, never stay running");
    assert.equal(runtime.activeContractId, null, "the un-dispatched contract must not be adopted as active");
    // executor 起跑门：status==="idle" && Number.isFinite(nextWakeAt) && nextWakeAt <= now
    assert.equal(Number.isFinite(runtime.nextWakeAt), true, "start failure must keep a wake source alive");
    assert.equal(runtime.nextWakeAt > before, true, "the retry is scheduled into the future (backoff, not a spin)");
    assert.equal(
      runtime.nextWakeAt <= before + (COOLDOWN_SECONDS * 1000) + 5000,
      true,
      "backoff follows wakePolicy.cooldownSeconds, not an unbounded delay",
    );
  });
});

test("a successful dispatch still starts the round and marks it running", async () => {
  const automationId = `automation-start-success-${Date.now()}`;
  await withAutomation(automationId, async () => {
    const result = await startAutomationRound(automationId, {
      api: {},
      logger: buildLogger(),
      dispatchAcceptIngressMessageFn: async () => ({
        ok: true,
        contractId: "TC-AUTOMATION-DISPATCH-OK",
      }),
    });

    assert.equal(result.skipped, false, "a successful dispatch is a real start");
    assert.equal(result.runtime?.status, "running");
    assert.equal(result.runtime?.activeContractId, "TC-AUTOMATION-DISPATCH-OK");
  });
});
