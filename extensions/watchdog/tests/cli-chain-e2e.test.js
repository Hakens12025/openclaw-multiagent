/**
 * cli-chain-e2e.test.js — 端到端链路样例（备忘录114 §6 ③）
 *
 * 按当前实现程度逐跳断言关节真实接头情况：
 *   CLI system → Operator → Automation
 * （Harness 关节已全退役，v226 / 2026-08-23：跳1 HarnessRun 组与 EvaluationResult
 *  构建器同批删除；deriveDecision 的 evaluationResult 死评价臂已于 2026-08-26 整删，
 *  跳4 现锁主干决策语义：terminalStatus/预算/指纹守卫驱动。）
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

// L4 CLI system
import {
  listCliSystemSurfaces,
  getCliSystemSurface,
  summarizeCliSystemSurfaces,
} from "../lib/cli-system/cli-surface-registry.js";

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

// ── 跳 2：runtime → CLI system ──────────────────────────────────────────────
//
// 目标：runtime 通过 CLI-system surface 可被正式观测。
// 具体路径：
//   - operator.snapshot surface 存在（inspect family）→ 聚合观测入口
//   - observe.track_progress / observe.alert → runtime hook 级观测
//   - CLI-system surface registry 已收口以上 surface，不直接读内部变量
//
// （HarnessRun 专属 inspect.harness_runs surface 已随 harness 全退役删除，v226 / 2026-08-23）

test("[跳2] CLI system surface registry 包含 operator.snapshot 聚合观测入口", () => {
  // operator.snapshot 是 operator 数据的正式聚合入口（inspect family）
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

test("[跳2] listCliSystemSurfaces 可枚举到含沙箱守卫 hook 的 surface", () => {
  // 声明式沙箱守卫（tool_access/scope）通过 hook.before_tool_call 进行运行时拦截
  const hookSurface = getCliSystemSurface("hook.before_tool_call");
  assert.ok(hookSurface, "hook.before_tool_call 必须存在");
  assert.equal(hookSurface.family, "hook");
  assert.ok(hookSurface.summary?.includes("沙箱"), `summary 应提及沙箱守卫, got: ${hookSurface.summary}`);
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
// （HarnessRun 观测链已随 harness 全退役删除，v226 / 2026-08-23）

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

// ── 跳 4：Automation — 主干决策（terminalStatus/预算/指纹守卫驱动）──────────────
//
// 目标：deriveDecision 主干跑通并断言决策类型。
// （evaluationResult 死评价臂已整删，2026-08-26：verdict/continueHint 分支自
//   harness 判定链退役后生产恒不可达——唯一调用方 automation-finalize 恒传 null。）
//
// ProfileLifecycle 说明：
//   ProfileLifecycle 是对象链的第四跳（AutomationDecision → ProfileLifecycle）。
//   P4 已建（lib/automation/profile-lifecycle.js），对象链完整闭合到尾段。
//   下方「[跳4→尾] 对象链闭合」test 做端到端因果链断言（行为验证，非结构存在）。

test("[跳4] deriveDecision 主干：wakeOnResult + 成功终态 → continue_on_result", () => {
  const spec = {
    enabled: true,
    wakePolicy: { onResult: true, cooldownSeconds: 30 },
    governance: { mode: "continuous", maxRounds: 5 },
  };
  const runtime = { bestScore: null, noImprovementStreak: 0 };

  const decision = deriveDecision(spec, runtime, {
    round: 1,
    terminalStatus: "completed",
    score: 0.9,
    noImprovementStreak: 0,
  });

  // 断言 AutomationDecision 合规
  assert.ok(decision, "deriveDecision 必须返回对象");
  assert.ok(typeof decision.action === "string", "action 必须是字符串");
  assert.ok(typeof decision.reason === "string", "reason 必须是字符串");
  assert.ok(Number.isFinite(decision.ts), "ts 必须是有限数");

  assert.equal(decision.action, "continue",
    `wakeOnResult 成功终态应产出 action=continue, got: ${decision.action}`);
  assert.equal(decision.reason, "continue_on_result",
    `reason 应为 continue_on_result, got: ${decision.reason}`);
  assert.ok(Number.isFinite(decision.nextWakeAt), "continue 决策必须带 nextWakeAt");
});

test("[跳4] deriveDecision 主干：失败终态 + !wakeOnFailure → abandon", () => {
  const spec = {
    enabled: true,
    wakePolicy: { onResult: true, cooldownSeconds: 30 },
    governance: { mode: "continuous", maxRounds: 10 },
  };
  const runtime = { bestScore: 0.7, noImprovementStreak: 1 };

  const decision = deriveDecision(spec, runtime, {
    round: 2,
    terminalStatus: "failed",
    score: 0.3,
    noImprovementStreak: 1,
  });

  assert.equal(decision.action, "abandon",
    `失败终态且不重试应产出 action=abandon, got: ${decision.action}`);
  assert.equal(decision.reason, "round_failed",
    `reason 应为 round_failed, got: ${decision.reason}`);
});

test("[跳4] 死评价臂不复活：evaluationResult 入参被忽略，决策走主干", () => {
  // 反证判据：旧评价臂在场时,下面这个入参会短路成 reviewer_conclude 并透传 verdict=pass;
  // 主干则忽略未知键,走 wakeOnResult → continue_on_result,verdict 恒 null。
  const spec = { enabled: true, wakePolicy: { onResult: true, cooldownSeconds: 10 }, governance: { mode: "continuous", maxRounds: 10 } };
  const decision = deriveDecision(spec, {}, {
    round: 1,
    terminalStatus: "completed",
    score: 0.9,
    noImprovementStreak: 0,
    evaluationResult: { verdict: "pass", continueHint: "conclude", score: 0.9, round: 1 },
  });
  assert.equal(decision.reason, "continue_on_result", "评价臂复活会给出 reviewer_conclude");
  assert.equal(decision.verdict, null, "verdict 不再从评价对象透传");
});

test("[跳4] normalizeAutomationDecision 对 deriveDecision 输出做二次 normalize 保持幂等", () => {
  const spec = { enabled: true, wakePolicy: { onResult: true, cooldownSeconds: 10 }, governance: { mode: "continuous" } };
  const runtime = {};

  const decision = deriveDecision(spec, runtime, { round: 1, terminalStatus: "completed", score: 0.9, noImprovementStreak: 0 });
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
//   resolveGovernance(spec, runtime{snapshot}) 真读到收紧值（下轮决策读到收紧治理）。
//
// 与 P4 closed-loop 测试（automation-profile-lifecycle-closed-loop-p4）的分工：
//   那里验持久化往返（真 runtime store upsert→read）+ 安全阀（熔断/复活）；
//   这里验对象链尾段的纯因果完整性（Decision→ProfileLifecycle，无 IO）。

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

test("[全链路] AutomationDecision → ProfileLifecycle 完整流转", () => {
  // （HarnessRun → EvaluationResult 两环已随 harness 全退役删除，v226 / 2026-08-23；
  //   deriveDecision 的 evaluationResult 死评价臂随后整删，2026-08-26。
  //   本用例守退役后存活的对象链：deriveDecision 主干 → buildProfileLifecycle。）

  // 产出 AutomationDecision（治理层）
  const automationSpec = {
    enabled: true,
    wakePolicy: { onResult: true, cooldownSeconds: 60 },
    governance: { mode: "continuous", maxRounds: 10 },
  };
  const automationRuntime = { bestScore: 0.5, noImprovementStreak: 0 };

  const decision = deriveDecision(automationSpec, automationRuntime, {
    round: 3,
    terminalStatus: "completed",
    score: 0.88,
    noImprovementStreak: 0,
  });

  // 派生 ProfileLifecycle（尾段，AutomationDecision + 证据 → ProfileLifecycle）。
  const lifecycle = buildProfileLifecycle({
    spec: { id: "e2e-full-chain-automation", governance: automationSpec.governance },
    runtime: { automationId: "e2e-full-chain-automation" },
    profileId: "coding.patch_and_test",
    profileTrustLevel: "provisional",
    lastDecision: decision,
    recentEvaluationResults: [{ verdict: "pass" }, { verdict: "pass" }],
  });

  // 全链路断言
  assert.ok(typeof decision.action === "string", "AutomationDecision.action 存在");
  assert.equal(decision.reason, "continue_on_result", "主干决策：wakeOnResult 成功终态续轮");
  assert.ok(lifecycle, "ProfileLifecycle 尾段对象产出");
  assert.equal(lifecycle.automationId, "e2e-full-chain-automation", "ProfileLifecycle → automation 关联完整");
  assert.ok(["experimental", "provisional", "stable"].includes(lifecycle.trustLevel), "ProfileLifecycle.trustLevel 在信任阶梯内");

  // 链路摘要（用于人工验证报告）—— 对象链完整闭合到尾段：
  // deriveDecision 主干 → AutomationDecision                          ✅ 已接上
  // AutomationDecision + 证据 → ProfileLifecycle.trustLevel/snapshot ✅ 已接上（P4 建，对象链闭合）
});
