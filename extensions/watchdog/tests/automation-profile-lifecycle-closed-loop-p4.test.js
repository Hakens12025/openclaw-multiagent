/**
 * automation-profile-lifecycle-closed-loop-p4.test.js — P4 死链 c 闭环回归门
 *
 * 断「真闭环」非「字段被写」：
 *  闭环：provisional automation 连 pass → trustLevel 升 → governanceSnapshot 落 runtime
 *        → 下一轮 resolveGovernance 读到收紧的 governance（端到端回灌真发生）。
 *  安全阀：熔断（disableGovernanceSnapshot）→ resolveGovernance 忽略 snapshot 回 spec；
 *          retired → operator 经 setAutomationGovernanceControl 复活（清 lifecycle + snapshot）。
 *
 * 经真 runtime store（upsert→读回），不 mock，证明持久化往返不丢字段。
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  upsertAutomationRuntimeState,
  getAutomationRuntimeState,
  deleteAutomationRuntimeState,
  setAutomationGovernanceControl,
} from "../lib/automation/automation-runtime.js";
import { buildProfileLifecycle } from "../lib/automation/profile-lifecycle.js";
import { resolveGovernance } from "../lib/automation/resolve-governance.js";

const SPEC = {
  id: "p4-closed-loop-automation",
  enabled: true,
  governance: { mode: "continuous", maxRounds: 20, earlyStopPatience: 10, minImprovement: 0 },
  harness: { profileId: "coding.patch_and_test" },
};

function passRound(round) {
  return { round, decision: "completed", status: "completed", score: 0.9, verdict: "pass" };
}

test("[闭环] 连 3 pass → trustLevel 升 → snapshot 落 runtime → 下一轮 resolveGovernance 读到收紧值", async () => {
  const automationId = SPEC.id;
  await deleteAutomationRuntimeState(automationId);

  // 模拟历史：runtime 已记录 2 个 pass round；本轮（lastDecision）再 pass → streak=3。
  const seededRuntime = await upsertAutomationRuntimeState({
    automationId,
    status: "idle",
    recentRounds: [passRound(2), passRound(1)],
    governanceSnapshot: null,
    profileLifecycle: null,
  });

  // 本轮 finalize 等价：派生 ProfileLifecycle（trust 种子 provisional）。
  const lifecycle = buildProfileLifecycle({
    spec: SPEC,
    runtime: seededRuntime,
    profileId: "coding.patch_and_test",
    profileTrustLevel: "provisional",
    lastDecision: { action: "continue", verdict: "pass", reason: "reviewer_continue" },
    recentEvaluationResults: [{ verdict: "pass" }],
  });

  assert.ok(lifecycle.successStreak >= 3, `successStreak 应 >=3，实际 ${lifecycle.successStreak}`);
  assert.equal(lifecycle.trustLevel, "stable", "provisional + 连3pass → 升到 stable");
  assert.ok(lifecycle.governanceSnapshot, "升级后必产出收紧 governanceSnapshot");

  // 把 lifecycle 结果落回 runtime（等价 finalizeAutomationRound 的持久化）。
  const persisted = await upsertAutomationRuntimeState({
    ...seededRuntime,
    profileLifecycle: lifecycle,
    governanceSnapshot: lifecycle.governanceSnapshot,
  });

  // 读回 runtime store，确认往返不丢字段。
  const readBack = await getAutomationRuntimeState(automationId);
  assert.ok(readBack.governanceSnapshot, "runtime 持久化 governanceSnapshot 往返不丢");
  assert.equal(readBack.profileLifecycle.trustLevel, "stable", "profileLifecycle 往返保真");

  // 闭环顶点：下一轮 resolveGovernance 必须读到收紧值（比 spec 更紧）。
  const resolvedNextRound = resolveGovernance(SPEC, readBack);
  assert.ok(
    resolvedNextRound.earlyStopPatience < SPEC.governance.earlyStopPatience
      || resolvedNextRound.maxRounds < SPEC.governance.maxRounds,
    `下一轮 governance 必须比 spec 紧（回灌真发生）：${JSON.stringify(resolvedNextRound)}`,
  );

  await deleteAutomationRuntimeState(automationId);
  void persisted;
});

test("[安全阀] 熔断 disableGovernanceSnapshot → resolveGovernance 忽略 snapshot 回 spec", async () => {
  const automationId = SPEC.id;
  await deleteAutomationRuntimeState(automationId);

  await upsertAutomationRuntimeState({
    automationId,
    status: "idle",
    governanceSnapshot: { maxRounds: 3, earlyStopPatience: 2 },
    governanceSnapshotDisabled: false,
  });

  // 熔断前：snapshot 生效。
  let runtime = await getAutomationRuntimeState(automationId);
  assert.equal(resolveGovernance(SPEC, runtime).maxRounds, 3, "熔断前 snapshot 生效");

  // operator 经 apply 路径开熔断。
  runtime = await setAutomationGovernanceControl(automationId, { disableGovernanceSnapshot: true });
  assert.equal(runtime.governanceSnapshotDisabled, true, "熔断标志持久化");
  assert.equal(resolveGovernance(SPEC, runtime).maxRounds, 20, "熔断后忽略 snapshot 回 spec.maxRounds=20");

  // operator 关熔断 → snapshot 恢复生效（双向可逆）。
  runtime = await setAutomationGovernanceControl(automationId, { disableGovernanceSnapshot: false });
  assert.equal(resolveGovernance(SPEC, runtime).maxRounds, 3, "关熔断后 snapshot 恢复生效");

  await deleteAutomationRuntimeState(automationId);
});

test("[安全阀] retired profile → operator 复活清 lifecycle + snapshot（streak 重置）", async () => {
  const automationId = SPEC.id;
  await deleteAutomationRuntimeState(automationId);

  const retiredLifecycle = buildProfileLifecycle({
    spec: SPEC,
    runtime: { automationId, recentRounds: [
      { round: 2, decision: "error", status: "failed", verdict: "fail", score: 0.1 },
      { round: 1, decision: "error", status: "failed", verdict: "fail", score: 0.1 },
    ] },
    profileId: "coding.patch_and_test",
    profileTrustLevel: "provisional",
    lastDecision: { action: "abandon", verdict: "fail", reason: "reviewer_fail" },
  });
  assert.equal(retiredLifecycle.status, "retired", "连 2 fail → retired");

  await upsertAutomationRuntimeState({
    automationId,
    status: "error",
    profileLifecycle: retiredLifecycle,
    governanceSnapshot: { maxRounds: 5 },
  });

  // operator 复活。
  const revived = await setAutomationGovernanceControl(automationId, { reviveProfile: true });
  assert.equal(revived.profileLifecycle, null, "复活清 profileLifecycle（streak 派生量重置）");
  assert.equal(revived.governanceSnapshot, null, "复活清 governanceSnapshot");

  // 复活后 resolveGovernance 回 spec 默认。
  assert.equal(resolveGovernance(SPEC, revived).maxRounds, 20, "复活后回 spec 默认");

  await deleteAutomationRuntimeState(automationId);
});
