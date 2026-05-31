/**
 * cli-chain-e2e.test.js — 端到端链路样例（备忘录114 §6 ③）
 *
 * 按当前实现程度逐跳断言四关节真实接头情况：
 *   Harness → CLI system → Operator → Automation
 *
 * 写作原则：诚实第一。
 * - 接上了 → 断言 + 注释说明哪里接上
 * - 断点   → 标为 FINDING，不伪造全绿
 * - ProfileLifecycle 已建（P4，lib/automation/profile-lifecycle.js）→ 对象链完整闭合到尾段，
 *   端到端断言因果链：连 3 pass → trustLevel 升级 → governanceSnapshot 收紧 → resolveGovernance 读到收紧值。
 */

import test from "node:test";
import assert from "node:assert/strict";

// ── 导入四关节模块 ────────────────────────────────────────────────────────────

// L3 Harness
import { validateHarnessModuleDefinition } from "../lib/harness/harness-module-schema.js";
import { normalizeHarnessRun, startHarnessRun, finalizeHarnessRun } from "../lib/harness/harness-run.js";
import { buildEvaluationResult } from "../lib/harness/evaluator-result.js";

// L4 CLI system
import {
  listCliSystemSurfaces,
  getCliSystemSurface,
  summarizeCliSystemSurfaces,
} from "../lib/cli-system/cli-surface-registry.js";
import { validateCliSurface } from "../lib/cli-system/cli-surface-schema.js";

// L5 Operator（读侧）
import {
  listOperatorExecutableSurfaceIds,
  isOperatorExecutableSurfaceId,
} from "../lib/operator/operator-surface-policy.js";

// L5 Automation
import { deriveDecision, normalizeAutomationDecision } from "../lib/automation/automation-decision.js";
// 对象链尾段（第 11 概念，P4 已建）：AutomationDecision → ProfileLifecycle。
import { buildProfileLifecycle } from "../lib/automation/profile-lifecycle.js";
import { resolveGovernance } from "../lib/automation/resolve-governance.js";

// ── 跳 1：Harness → HarnessRun ───────────────────────────────────────────────
//
// 目标：构造合规 HarnessModuleDefinition → startHarnessRun → finalizeHarnessRun
// 并断言产出 HarnessRun 符合冻结 schema（validateHarnessModuleDefinition +
// normalizeHarnessRun 双重校验）。
// 接头状态：✅ 已接上。HarnessRun 是活对象，schema 已冻结。

test("[跳1] 合规 HarnessModuleDefinition 通过 schema 校验", () => {
  const def = { id: "harness:gate.artifact", kind: "gate" };
  const { ok, problems } = validateHarnessModuleDefinition(def);
  assert.equal(ok, true, `schema 校验失败: ${problems.join("; ")}`);
});

test("[跳1] startHarnessRun 产出合规 HarnessRun（含必填字段）", () => {
  const spec = {
    automationId: "e2e-sample-automation",
    round: 1,
    trigger: "manual",
    requestedAt: Date.now(),
    enabled: true,
    executionMode: "guarded",
  };

  const run = startHarnessRun(spec);

  // HarnessRun 必填字段断言
  assert.ok(run, "startHarnessRun 必须返回对象");
  assert.ok(typeof run.id === "string" && run.id.startsWith("harness:"), `id 格式不合规: ${run.id}`);
  assert.equal(run.automationId, "e2e-sample-automation");
  assert.equal(run.round, 1);
  assert.equal(run.status, "running");
  assert.equal(run.enabled, true);
  assert.equal(run.executionMode, "guarded");
  assert.ok(Number.isFinite(run.startedAt), "startedAt 必须是有限数");
  assert.equal(run.finalizedAt, null, "running 状态下 finalizedAt 应为 null");
});

test("[跳1] finalizeHarnessRun 产出完整终态 HarnessRun", () => {
  const spec = {
    automationId: "e2e-sample-automation",
    round: 1,
    requestedAt: Date.now(),
    enabled: true,
    executionMode: "guarded",
  };
  const run = startHarnessRun(spec);

  const finalized = finalizeHarnessRun(run, {
    terminalStatus: "completed",
    score: 0.85,
    artifact: "/tmp/e2e-sample.patch",
    summary: "e2e test run",
    decision: "continue",
  });

  assert.ok(finalized, "finalizeHarnessRun 必须返回对象");
  assert.equal(finalized.status, "completed");
  assert.equal(finalized.terminalStatus, "completed");
  assert.equal(finalized.score, 0.85);
  assert.equal(finalized.artifact, "/tmp/e2e-sample.patch");
  assert.equal(finalized.decision, "continue");
  assert.ok(Number.isFinite(finalized.finalizedAt), "finalizedAt 必须是有限数");

  // normalizeHarnessRun 二次校验确保 schema 合规
  const renormalized = normalizeHarnessRun(finalized);
  assert.ok(renormalized, "renormalized HarnessRun 必须合规");
  assert.equal(renormalized.id, finalized.id, "二次 normalize 后 id 不变");
});

// ── 跳 2：HarnessRun → CLI system ───────────────────────────────────────────
//
// 目标：HarnessRun/runtime 通过 CLI-system surface 可被正式观测。
// 具体路径：
//   - operator.snapshot surface 存在（inspect family）→ 是 HarnessRun 数据的正式观测入口
//   - observe.track_progress / observe.alert → runtime hook 级观测
//   - CLI-system surface registry 已收口以上 surface，不直接读内部变量
//
// 接头状态：✅ 已接上（P-D.2 收口）。
//   - surface 存在于 registry（listCliSystemSurfaces 可读取）✅
//   - HarnessRun 数据现有专属 inspect surface `inspect.harness_runs`，
//     封装 listRecentHarnessRuns，作为 operator 读 HarnessRun 的正式入口 ✅
//   - operator.snapshot（inspect family）是聚合视图，HarnessRun 子数据经
//     inspect.harness_runs 收口，不再直读 store。

test("[跳2] CLI system surface registry 包含 HarnessRun 正式观测入口（inspect.harness_runs）", () => {
  // inspect.harness_runs 是 HarnessRun store 查询的正式收口入口（inspect family）
  const harnessRunsSurface = getCliSystemSurface("inspect.harness_runs");
  assert.ok(harnessRunsSurface, "inspect.harness_runs surface 必须存在于 CLI-system registry");
  assert.equal(harnessRunsSurface.family, "inspect");
  assert.equal(harnessRunsSurface.status, "active");
  assert.ok(harnessRunsSurface.summary?.includes("HarnessRun"), "summary 应提及 HarnessRun");
  const { ok, problems } = validateCliSurface(harnessRunsSurface);
  assert.equal(ok, true, `inspect.harness_runs 必须通过冻结 schema: ${problems.join("; ")}`);

  // operator.snapshot 仍是 HarnessRun 数据的正式聚合入口（inspect family）
  const snapshotSurface = getCliSystemSurface("operator.snapshot");
  assert.ok(snapshotSurface, "operator.snapshot surface 必须存在于 CLI-system registry");
  assert.equal(snapshotSurface.family, "inspect");
  assert.equal(snapshotSurface.status, "active");
  assert.ok(snapshotSurface.summary?.includes("operator"), "summary 应提及 operator");
});

test("[跳2] CLI system surface registry 包含 runtime 观测 surface（observe family）", () => {
  const trackSurface = getCliSystemSurface("observe.track_progress");
  assert.ok(trackSurface, "observe.track_progress 必须存在");
  assert.equal(trackSurface.family, "observe");
  assert.equal(trackSurface.status, "active");

  const alertSurface = getCliSystemSurface("observe.alert");
  assert.ok(alertSurface, "observe.alert 必须存在");
  assert.equal(alertSurface.family, "observe");
});

test("[跳2] listCliSystemSurfaces 可枚举到含 harness guard hook 的 surface", () => {
  // harness guard 通过 hook.before_tool_call 进行运行时拦截
  const hookSurface = getCliSystemSurface("hook.before_tool_call");
  assert.ok(hookSurface, "hook.before_tool_call 必须存在");
  assert.equal(hookSurface.family, "hook");
  assert.ok(hookSurface.summary?.includes("harness"), `summary 应提及 harness, got: ${hookSurface.summary}`);
});

test("[跳2] summarizeCliSystemSurfaces 包含全五类 family 的 surface", () => {
  const { counts } = summarizeCliSystemSurfaces();
  // 五类 family 都有 surface，说明 CLI system 层覆盖了完整操作面
  assert.ok(counts.byFamily.hook >= 1, "hook family 至少 1 个 surface");
  assert.ok(counts.byFamily.observe >= 1, "observe family 至少 1 个 surface");
  assert.ok(counts.byFamily.inspect >= 1, "inspect family 至少 1 个 surface");
  assert.ok(counts.byFamily.apply >= 1, "apply family 至少 1 个 surface");
  assert.ok(counts.byFamily.verify >= 1, "verify family 至少 1 个 surface");
  assert.ok(counts.total >= 5, `surface 总数至少 5 个, got: ${counts.total}`);
});

// ── 跳 3：CLI system → Operator ─────────────────────────────────────────────
//
// 目标：operator 经 formal truth + surface 形成治理输入。
// 诚实标注：
//   - operator-surface-policy.js 正式从 CLI-system registry 消费 surface ✅
//   - listOperatorExecutableSurfaceIds() 走 getCliSystemSurface 路径，不直接读内部
//   - buildOperatorSnapshot 消费 summarizeCliSystemSurfaces（通过 CLI-system registry）✅
//   - 但 buildOperatorSnapshot 是全系统 async 调用，需要完整 store/registry 运行；
//     本单元测试只验证 operator 读 surface 的路径（operator-surface-policy），
//     不实际调用 buildOperatorSnapshot（避免依赖 file-system store 初始化）。
//
// 已迁移（P-D.2）：operator-snapshot.js 中 harnessRuns 的数据来源已从
//   listRecentHarnessRuns（直读文件系统）收口为经 CLI-system 的
//   inspect.harness_runs surface（inspectCliSystemSurface）转发。
//   operator 读 HarnessRun 不再绕过 CLI-system 层，旁路已闭合。
//   行为完全等价（同一函数、同一 limit 语义），见
//   tests/operator-harness-runs-surface.test.js 锁定。

test("[跳3] operator 读 HarnessRun 经 inspect.harness_runs surface（旁路已闭合）", async () => {
  // P-D.2 收口：operator-snapshot 不再直读 harness-run-store，
  // 改经 CLI-system inspect surface 读取。
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(
    new URL("../lib/operator/operator-snapshot.js", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(source, /listRecentHarnessRuns/,
    "operator-snapshot 不应再直读 harness-run-store（旁路已闭合）");
  assert.match(source, /inspectCliSystemSurface/,
    "operator-snapshot 应经 inspectCliSystemSurface 读 HarnessRun");
  assert.match(source, /inspect\.harness_runs/,
    "operator-snapshot 应引用 inspect.harness_runs surface id");

  // inspect.harness_runs 是 inspect family，不被 operator 视为可执行（只读观测）
  assert.equal(
    isOperatorExecutableSurfaceId("inspect.harness_runs"),
    false,
    "inspect.harness_runs 是只读观测 surface，不应是 operator-executable",
  );
});

test("[跳3] operator-surface-policy 从 CLI-system registry 读取 surface（不绕过 CLI system）", () => {
  // operator-surface-policy.js 的 listOperatorExecutableSurfaceIds 走 listCliSystemSurfaces
  const ids = listOperatorExecutableSurfaceIds();
  assert.ok(Array.isArray(ids), "listOperatorExecutableSurfaceIds 必须返回数组");
  // apply family 中 operatorExecutable+executable 为 true 的 surface 应有若干个
  assert.ok(ids.length >= 1, `operator-executable surface 数量应 >= 1, got: ${ids.length}`);
  // 每个 id 都能通过 getCliSystemSurface 取回。
  // P5：operator 主动治理可执行 family = apply（写）+ verify（主动验证）；
  // inspect/observe/hook 绝不入可执行集。
  for (const id of ids) {
    const surface = getCliSystemSurface(id);
    assert.ok(surface, `surface ${id} 应能通过 CLI-system registry 取回`);
    assert.ok(["apply", "verify"].includes(surface.family), `surface ${id} 应为 apply 或 verify family`);
    assert.equal(surface.operatorExecutable, true, `surface ${id} operatorExecutable 应为 true`);
  }
});

test("[跳3] isOperatorExecutableSurfaceId 正确判断 apply 类可执行 surface", () => {
  // 取一个已知 apply+operatorExecutable surface（automations.enable）
  const knownApplySurface = listCliSystemSurfaces({
    family: "apply",
    operatorExecutable: true,
    status: "active",
  }).find((s) => s.executable === true);

  if (!knownApplySurface) {
    // 若无满足条件的 surface（异常情况），仅记录
    assert.fail("预期至少存在一个 apply+operatorExecutable+executable surface");
  }

  assert.equal(
    isOperatorExecutableSurfaceId(knownApplySurface.id),
    true,
    `${knownApplySurface.id} 应被识别为 operator-executable`,
  );
});

test("[跳3] 非 apply family 的 surface 不被 operator 视为 executable（observe 不能被 operator 执行）", () => {
  // observe.track_progress 是只读 surface，不能被 operator 执行
  assert.equal(
    isOperatorExecutableSurfaceId("observe.track_progress"),
    false,
    "observe.track_progress 不应是 operator-executable",
  );
  // inspect surface 同理
  assert.equal(
    isOperatorExecutableSurfaceId("operator.snapshot"),
    false,
    "operator.snapshot（inspect）不应是 operator-executable",
  );
});

// ── 跳 4：Automation — EvaluationResult → AutomationDecision ─────────────────
//
// 目标：EvaluationResult → deriveDecision → AutomationDecision 跑通并断言决策类型。
// 接头状态：✅ 已接上。deriveDecision 正式接受 evaluationResult 参数，
//   并优先于 reviewerResult（见 automation-decision.js:121）。
//
// ProfileLifecycle 说明：
//   ProfileLifecycle 是对象链的第四跳（AutomationDecision → ProfileLifecycle）。
//   P4 已建（lib/automation/profile-lifecycle.js），对象链完整闭合到尾段。
//   下方「[跳4→尾] 对象链闭合」test 做端到端因果链断言（行为验证，非结构存在）。

test("[跳4] buildEvaluationResult 产出合规 EvaluationResult 对象", () => {
  const harnessRunId = "harness:e2e-sample-automation:round:1:ts:123456";
  const er = buildEvaluationResult({
    harnessRunId,
    verdict: "pass",
    continueHint: "conclude",
    score: 0.9,
    round: 1,
  });

  assert.ok(er, "buildEvaluationResult 必须返回对象");
  assert.ok(typeof er.id === "string" && er.id.startsWith("er-"), `id 格式不合规: ${er.id}`);
  assert.equal(er.evaluationResultId, er.id, "evaluationResultId 应等于 id");
  assert.equal(er.harnessRunId, harnessRunId);
  assert.equal(er.verdict, "pass");
  assert.equal(er.continueHint, "conclude");
  assert.equal(er.score, 0.9);
  assert.equal(er.round, 1);
});

test("[跳4] deriveDecision 消费 EvaluationResult 并产出正确 AutomationDecision", () => {
  const harnessRunId = "harness:e2e-sample-automation:round:1:ts:123456";

  // 构造 EvaluationResult（评估层产出）
  const evaluationResult = buildEvaluationResult({
    harnessRunId,
    verdict: "pass",
    continueHint: "conclude",
    score: 0.9,
    round: 1,
  });

  // 构造 automation spec（治理层消费侧输入）
  const spec = {
    enabled: true,
    wakePolicy: { onResult: true, cooldownSeconds: 30 },
    governance: { mode: "continuous", maxRounds: 5 },
  };
  const runtime = { bestScore: null, noImprovementStreak: 0 };

  // deriveDecision 正式接受 evaluationResult
  const decision = deriveDecision(spec, runtime, {
    round: 1,
    terminalStatus: "completed",
    score: evaluationResult.score,
    noImprovementStreak: 0,
    evaluationResult, // 正式传入 EvaluationResult
  });

  // 断言 AutomationDecision 合规
  assert.ok(decision, "deriveDecision 必须返回对象");
  assert.ok(typeof decision.action === "string", "action 必须是字符串");
  assert.ok(typeof decision.reason === "string", "reason 必须是字符串");
  assert.ok(Number.isFinite(decision.ts), "ts 必须是有限数");

  // EvaluationResult continueHint=conclude → action 应为 conclude
  assert.equal(decision.action, "conclude",
    `continueHint=conclude 应产出 action=conclude, got: ${decision.action}`);
  assert.equal(decision.reason, "reviewer_conclude",
    `reason 应为 reviewer_conclude, got: ${decision.reason}`);
  assert.equal(decision.verdict, "pass",
    `verdict 应从 EvaluationResult.verdict 透传, got: ${decision.verdict}`);
});

test("[跳4] deriveDecision 在 evaluationResult.verdict=fail+wakeOnFailure 时产出 rework 决策", () => {
  const evaluationResult = buildEvaluationResult({
    harnessRunId: "harness:e2e:round:2:ts:999",
    verdict: "fail",
    continueHint: "rework",
    score: 0.3,
    round: 2,
  });

  const spec = {
    enabled: true,
    wakePolicy: { onResult: true, onFailure: true, cooldownSeconds: 30 },
    governance: { mode: "continuous", maxRounds: 10 },
  };
  const runtime = { bestScore: 0.7, noImprovementStreak: 1 };

  const decision = deriveDecision(spec, runtime, {
    round: 2,
    terminalStatus: "failed",
    score: 0.3,
    noImprovementStreak: 1,
    evaluationResult,
  });

  // reviewer hint=rework → action=rework
  assert.equal(decision.action, "rework",
    `continueHint=rework 应产出 action=rework, got: ${decision.action}`);
});

test("[跳4] normalizeAutomationDecision 对 deriveDecision 输出做二次 normalize 保持幂等", () => {
  const evaluationResult = buildEvaluationResult({
    harnessRunId: "harness:e2e:round:1:ts:111",
    verdict: "pass",
    continueHint: "conclude",
    score: 0.9,
    round: 1,
  });
  const spec = { enabled: true, wakePolicy: { onResult: true, cooldownSeconds: 10 }, governance: { mode: "continuous" } };
  const runtime = {};

  const decision = deriveDecision(spec, runtime, { round: 1, terminalStatus: "completed", score: 0.9, noImprovementStreak: 0, evaluationResult });
  const renormalized = normalizeAutomationDecision(decision);

  assert.ok(renormalized, "renormalized AutomationDecision 必须合规");
  assert.equal(renormalized.action, decision.action, "二次 normalize 后 action 不变");
  assert.equal(renormalized.reason, decision.reason, "二次 normalize 后 reason 不变");
  assert.equal(renormalized.verdict, decision.verdict, "二次 normalize 后 verdict 不变");
});

// ── 跳 4 → 尾段：AutomationDecision → ProfileLifecycle（对象链闭合）─────────────
//
// ProfileLifecycle（第 11 概念）P4 已建（lib/automation/profile-lifecycle.js）。
// e2e 视角断言「对象链完整到尾段」+ 因果链真转（行为验证）：
//   连 3 pass → trustLevel 真升级 → deriveGovernanceSnapshot 真收紧 →
//   resolveGovernance(spec, runtime{snapshot}) 真读到收紧值（下轮 harness 读到收紧治理）。
//
// 与 P4 closed-loop 测试（automation-profile-lifecycle-closed-loop-p4）的分工：
//   那里验持久化往返（真 runtime store upsert→read）+ 安全阀（熔断/复活）；
//   这里验对象链尾段的纯因果完整性（HarnessRun→ER→Decision→ProfileLifecycle 一条龙、无 IO）。

test("[跳4→尾] 对象链闭合到 ProfileLifecycle：连 3 pass → trustLevel 真升级", () => {
  const spec = {
    id: "e2e-lifecycle-automation",
    enabled: true,
    governance: { mode: "continuous", maxRounds: 20, earlyStopPatience: 10 },
    harness: { profileId: "coding.patch_and_test" },
  };

  // 上游证据：本轮 pass（lastDecision）+ 前两轮 pass（recentEvaluationResults）→ streak=3。
  const lifecycle = buildProfileLifecycle({
    spec,
    runtime: { automationId: spec.id },
    profileId: "coding.patch_and_test",
    profileTrustLevel: "provisional",
    lastDecision: { action: "continue", verdict: "pass", reason: "reviewer_continue" },
    recentEvaluationResults: [{ verdict: "pass" }, { verdict: "pass" }],
  });

  // 链路尾段对象真实产出（非 undefined / 非结构占位）。
  assert.ok(lifecycle, "ProfileLifecycle 是对象链尾段，必须真实产出对象");
  assert.equal(lifecycle.automationId, spec.id, "ProfileLifecycle 关联 automation");
  assert.equal(lifecycle.profileId, "coding.patch_and_test", "ProfileLifecycle 关联 profile");
  assert.ok(lifecycle.successStreak >= 3, `连 3 pass 应使 successStreak>=3, got ${lifecycle.successStreak}`);
  // 因果：provisional + 连 3 pass → trustLevel 真升级到 stable（行为验证，非"字段存在"）。
  assert.equal(lifecycle.trustLevel, "stable", "provisional 连 3 pass → 升级到 stable");
});

test("[跳4→尾] 升级后 governanceSnapshot 真收紧 → resolveGovernance 真读到收紧值（回灌闭合）", () => {
  const spec = {
    id: "e2e-lifecycle-automation",
    enabled: true,
    governance: { mode: "continuous", maxRounds: 20, earlyStopPatience: 10 },
    harness: { profileId: "coding.patch_and_test" },
  };

  const lifecycle = buildProfileLifecycle({
    spec,
    runtime: { automationId: spec.id },
    profileId: "coding.patch_and_test",
    profileTrustLevel: "provisional",
    lastDecision: { action: "continue", verdict: "pass", reason: "reviewer_continue" },
    recentEvaluationResults: [{ verdict: "pass" }, { verdict: "pass" }],
  });

  // 升级（stable）→ deriveGovernanceSnapshot 真收紧（比 spec 小）。
  assert.equal(lifecycle.trustLevel, "stable");
  assert.ok(lifecycle.governanceSnapshot, "升级后必产出收紧 governanceSnapshot（非 null）");
  assert.ok(
    lifecycle.governanceSnapshot.maxRounds < spec.governance.maxRounds,
    `snapshot.maxRounds 应比 spec 小：${lifecycle.governanceSnapshot.maxRounds} < ${spec.governance.maxRounds}`,
  );
  assert.ok(
    lifecycle.governanceSnapshot.earlyStopPatience < spec.governance.earlyStopPatience,
    `snapshot.earlyStopPatience 应比 spec 小：${lifecycle.governanceSnapshot.earlyStopPatience} < ${spec.governance.earlyStopPatience}`,
  );

  // 闭环顶点：把 lifecycle 的 snapshot 放进 runtime，下一轮 resolveGovernance 真读到收紧值。
  const nextRuntime = { governanceSnapshot: lifecycle.governanceSnapshot };
  const resolved = resolveGovernance(spec, nextRuntime);
  assert.ok(
    resolved.maxRounds < spec.governance.maxRounds
      && resolved.earlyStopPatience < spec.governance.earlyStopPatience,
    `resolveGovernance 必须读到收紧治理（回灌真发生）：${JSON.stringify(resolved)}`,
  );

  // 熔断对照（安全阀真起作用）：disabled → 忽略 snapshot 回 spec 默认。
  const disabledResolved = resolveGovernance(spec, {
    governanceSnapshot: lifecycle.governanceSnapshot,
    governanceSnapshotDisabled: true,
  });
  assert.equal(disabledResolved.maxRounds, spec.governance.maxRounds, "熔断回 spec 默认 maxRounds");
});

// ── 全链路集成断言 ───────────────────────────────────────────────────────────

test("[全链路] HarnessRun → EvaluationResult → AutomationDecision 完整流转", () => {
  // 构造 HarnessRun（跳1产出）
  const spec = {
    automationId: "e2e-full-chain-automation",
    round: 3,
    requestedAt: Date.now(),
    enabled: true,
    executionMode: "guarded",
  };
  const run = startHarnessRun(spec);
  const finalizedRun = finalizeHarnessRun(run, {
    terminalStatus: "completed",
    score: 0.88,
    artifact: "/tmp/e2e-chain.patch",
  });

  // 构造 EvaluationResult（跳4评估层，链接到 HarnessRun）
  const evaluationResult = buildEvaluationResult({
    harnessRunId: finalizedRun.id,
    verdict: "pass",
    continueHint: "continue",
    score: finalizedRun.score,
    round: finalizedRun.round,
  });

  // 验证 EvaluationResult 与 HarnessRun 的关联
  assert.equal(evaluationResult.harnessRunId, finalizedRun.id,
    "EvaluationResult 必须通过 harnessRunId 与 HarnessRun 关联");

  // 产出 AutomationDecision（跳4治理层）
  const automationSpec = {
    enabled: true,
    wakePolicy: { onResult: true, cooldownSeconds: 60 },
    governance: { mode: "continuous", maxRounds: 10 },
  };
  const automationRuntime = { bestScore: 0.5, noImprovementStreak: 0 };

  const decision = deriveDecision(automationSpec, automationRuntime, {
    round: finalizedRun.round,
    terminalStatus: finalizedRun.terminalStatus,
    score: evaluationResult.score,
    noImprovementStreak: 0,
    evaluationResult,
  });

  // 派生 ProfileLifecycle（跳4尾段，AutomationDecision + 证据 → ProfileLifecycle）。
  const lifecycle = buildProfileLifecycle({
    spec: { id: spec.automationId, governance: automationSpec.governance, harness: { profileId: "coding.patch_and_test" } },
    runtime: { automationId: spec.automationId },
    profileId: "coding.patch_and_test",
    profileTrustLevel: "provisional",
    lastDecision: decision,
    recentEvaluationResults: [{ verdict: "pass" }, { verdict: "pass" }],
  });

  // 全链路断言
  assert.ok(finalizedRun.id.startsWith("harness:"), "HarnessRun.id 格式合规");
  assert.ok(evaluationResult.id.startsWith("er-"), "EvaluationResult.id 格式合规");
  assert.ok(evaluationResult.harnessRunId === finalizedRun.id, "EvaluationResult → HarnessRun 关联完整");
  assert.ok(typeof decision.action === "string", "AutomationDecision.action 存在");
  assert.ok(typeof decision.verdict === "string" || decision.verdict === null, "AutomationDecision.verdict 来自 EvaluationResult");
  assert.ok(lifecycle, "ProfileLifecycle 尾段对象产出");
  assert.equal(lifecycle.automationId, spec.automationId, "ProfileLifecycle → automation 关联完整");
  assert.ok(["experimental", "provisional", "stable"].includes(lifecycle.trustLevel), "ProfileLifecycle.trustLevel 在信任阶梯内");

  // 链路摘要（用于人工验证报告）—— 对象链完整闭合到尾段：
  // HarnessRun.id          → evaluationResult.harnessRunId          ✅ 已接上
  // EvaluationResult.verdict → AutomationDecision.verdict           ✅ 已接上
  // AutomationDecision + 证据 → ProfileLifecycle.trustLevel/snapshot ✅ 已接上（P4 建，对象链闭合）
});
