/**
 * W3 真值收口测试
 *
 * 覆盖两项任务:
 * 1. normalizeAutomationDecision 合一 — runtime.js 与 decision.js 两条路径产出一致
 * 2. EvaluationResult 独立可溯源对象 — 带 id/evaluationResultId 且 deriveDecision 行为不变
 */

import test from "node:test";
import assert from "node:assert/strict";

// ─── Task 1: normalizeAutomationDecision 单源 ───

import {
  normalizeAutomationDecision,
} from "../lib/automation/automation-decision.js";

// automation-runtime.js 内部的 normalizeAutomationRuntimeState 会用到 normalizeAutomationDecision
// 我们通过 upsertAutomationRuntimeState 的 round-trip 验证其产出与 decision.js 规范源一致
import {
  upsertAutomationRuntimeState,
  getAutomationRuntimeState,
  deleteAutomationRuntimeState,
} from "../lib/automation/automation-runtime.js";

test("normalizeAutomationDecision — decision.js 版对完整输入产出规范化结构", () => {
  const now = Date.now();
  const input = {
    action: "rework",
    decision: "continue",
    reason: "reviewer_rework",
    round: 3,
    score: 0.75,
    verdict: "fail",
    ts: now,
    status: "idle",
    nextWakeAt: now + 60000,
  };
  const result = normalizeAutomationDecision(input);
  assert.equal(result.action, "rework");
  assert.equal(result.decision, "continue");
  assert.equal(result.reason, "reviewer_rework");
  assert.equal(result.round, 3);
  assert.equal(result.score, 0.75);
  assert.equal(result.verdict, "fail");
  assert.equal(typeof result.ts, "number");
});

test("normalizeAutomationDecision — reason 为空时使用 'unknown' 兜底", () => {
  const result = normalizeAutomationDecision({ action: "continue", decision: "continue" });
  assert.equal(result.reason, "unknown");
  assert.equal(typeof result.ts, "number");
});

test("normalizeAutomationDecision — round 为 0 时 normalizePositiveInteger 兜底为 0", () => {
  const result = normalizeAutomationDecision({ decision: "continue", round: 0 });
  // decision.js 版 normalizePositiveInteger(0, 0) → 0
  assert.equal(result.round, 0);
});

test("runtime 存储 round-trip: lastAutomationDecision 经 normalizeAutomationRuntimeState 后语义不变", async () => {
  const automationId = `w3-normalize-test-${Date.now()}`;
  const now = Date.now();
  const decisionInput = {
    action: "rework",
    decision: "continue",
    reason: "reviewer_rework",
    round: 2,
    score: 0.6,
    verdict: "fail",
    ts: now,
    status: "idle",
    nextWakeAt: now + 60000,
  };

  // canonical result from decision.js
  const canonical = normalizeAutomationDecision(decisionInput);

  try {
    await upsertAutomationRuntimeState({
      automationId,
      status: "idle",
      currentRound: 2,
      lastAutomationDecision: decisionInput,
    });
    const saved = await getAutomationRuntimeState(automationId);
    const rtDecision = saved?.lastAutomationDecision;

    // 两条路径应产出相同结构（ts 可能因 Date.now() 兜底而有微小差异，但 input 带了 ts 故一致）
    assert.ok(rtDecision, "lastAutomationDecision should be persisted");
    assert.equal(rtDecision.action, canonical.action);
    assert.equal(rtDecision.decision, canonical.decision);
    assert.equal(rtDecision.reason, canonical.reason);
    assert.equal(rtDecision.round, canonical.round);
    assert.equal(rtDecision.score, canonical.score);
    assert.equal(rtDecision.verdict, canonical.verdict);
    assert.equal(rtDecision.status, canonical.status);
  } finally {
    await deleteAutomationRuntimeState(automationId).catch(() => {});
  }
});

// ─── Task 2: EvaluationResult 独立可溯源对象 ───

import { buildEvaluationResult } from "../lib/harness/evaluator-result.js";

test("buildEvaluationResult — 产出带 id 和 evaluationResultId 的可溯源对象", () => {
  const result = buildEvaluationResult({
    reviewerResultId: "rr-abc-123",
    harnessRunId: "hr-xyz-456",
    verdict: "pass",
    continueHint: "conclude",
    testsPassed: true,
  });
  assert.ok(typeof result.id === "string" && result.id.length > 0, "id should be a non-empty string");
  assert.ok(typeof result.evaluationResultId === "string" && result.evaluationResultId.length > 0);
  assert.equal(result.reviewerResultId, "rr-abc-123");
  assert.equal(result.harnessRunId, "hr-xyz-456");
  assert.equal(result.verdict, "pass");
  assert.equal(result.continueHint, "conclude");
  assert.equal(result.testsPassed, true);
});

test("buildEvaluationResult — 每次调用产出不同 id", () => {
  const a = buildEvaluationResult({ verdict: "pass" });
  const b = buildEvaluationResult({ verdict: "pass" });
  assert.notEqual(a.id, b.id);
  assert.notEqual(a.evaluationResultId, b.evaluationResultId);
});

test("buildEvaluationResult — 缺省字段有合理默认值", () => {
  const result = buildEvaluationResult({});
  assert.equal(result.verdict, "inconclusive");
  assert.equal(result.continueHint, null);
  assert.equal(result.testsPassed, null);
  assert.equal(result.reviewerResultId, null);
  assert.equal(result.harnessRunId, null);
});

// ─── Task 2: deriveDecision 消费 EvaluationResult 行为与旧 reviewerResult 等价 ───

import { deriveDecision } from "../lib/automation/automation-decision.js";
import { buildReviewerResult } from "../lib/harness/reviewer-result.js";

function makeSpec(overrides = {}) {
  return {
    id: "test-automation",
    enabled: true,
    wakePolicy: { type: "result", onResult: true, cooldownSeconds: 60 },
    governance: { mode: "continuous", maxRounds: 0 },
    ...overrides,
  };
}

function makeRuntime() {
  return { status: "running", currentRound: 1, bestScore: null, noImprovementStreak: 0 };
}

test("deriveDecision 消费 EvaluationResult — rework hint 产出 continue/rework", () => {
  const spec = makeSpec();
  const runtime = makeRuntime();
  const now = Date.now();

  // 旧路径: 直接用 reviewerResult
  const reviewerResult = buildReviewerResult({
    verdict: "fail",
    continueHint: "rework",
  });
  const oldDecision = deriveDecision(spec, runtime, {
    round: 1,
    terminalStatus: "completed",
    score: 0.5,
    noImprovementStreak: 0,
    reviewerResult,
  }, now);

  // 新路径: 先 buildEvaluationResult，然后 deriveDecision 接受 evaluationResult
  const evalResult = buildEvaluationResult({
    reviewerResultId: "rr-test",
    verdict: "fail",
    continueHint: "rework",
    testsPassed: false,
  });
  const newDecision = deriveDecision(spec, runtime, {
    round: 1,
    terminalStatus: "completed",
    score: 0.5,
    noImprovementStreak: 0,
    evaluationResult: evalResult,
  }, now);

  assert.equal(newDecision.action, oldDecision.action);
  assert.equal(newDecision.decision, oldDecision.decision);
  assert.equal(newDecision.reason, oldDecision.reason);
});

test("deriveDecision 消费 EvaluationResult — conclude hint 产出 completed", () => {
  const spec = makeSpec();
  const runtime = makeRuntime();
  const now = Date.now();

  const reviewerResult = buildReviewerResult({
    verdict: "pass",
    continueHint: "conclude",
  });
  const oldDecision = deriveDecision(spec, runtime, {
    round: 1,
    terminalStatus: "completed",
    score: 0.9,
    noImprovementStreak: 0,
    reviewerResult,
  }, now);

  const evalResult = buildEvaluationResult({
    reviewerResultId: "rr-test-2",
    verdict: "pass",
    continueHint: "conclude",
    testsPassed: true,
  });
  const newDecision = deriveDecision(spec, runtime, {
    round: 1,
    terminalStatus: "completed",
    score: 0.9,
    noImprovementStreak: 0,
    evaluationResult: evalResult,
  }, now);

  assert.equal(newDecision.action, oldDecision.action);
  assert.equal(newDecision.decision, oldDecision.decision);
  assert.equal(newDecision.reason, oldDecision.reason);
});

test("deriveDecision 消费 EvaluationResult — 无 hint、verdict=fail 且 wakeOnFailure=false 产出 abandon", () => {
  const spec = makeSpec({ wakePolicy: { type: "result", onResult: false }, governance: { mode: "continuous" } });
  const runtime = makeRuntime();
  const now = Date.now();

  const reviewerResult = buildReviewerResult({ verdict: "fail", continueHint: null });
  const oldDecision = deriveDecision(spec, runtime, {
    round: 1,
    terminalStatus: "completed",
    score: 0.2,
    noImprovementStreak: 0,
    reviewerResult,
  }, now);

  const evalResult = buildEvaluationResult({
    reviewerResultId: "rr-test-3",
    verdict: "fail",
    continueHint: null,
  });
  const newDecision = deriveDecision(spec, runtime, {
    round: 1,
    terminalStatus: "completed",
    score: 0.2,
    noImprovementStreak: 0,
    evaluationResult: evalResult,
  }, now);

  assert.equal(newDecision.action, oldDecision.action);
  assert.equal(newDecision.decision, oldDecision.decision);
});
