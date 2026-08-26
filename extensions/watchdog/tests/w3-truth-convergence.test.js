/**
 * W3 真值收口测试
 *
 * normalizeAutomationDecision 合一 — runtime.js 与 decision.js 两条路径产出一致。
 * （Task 2 的 EvaluationResult/deriveDecision 等价组已随 harness 全退役删除，
 *  v226 / 2026-08-23：EvaluationResult 与 reviewerResult 双源均已不存在。）
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
