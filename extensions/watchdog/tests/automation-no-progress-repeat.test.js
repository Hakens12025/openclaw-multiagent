/**
 * automation-no-progress-repeat.test.js — 跨轮内容级 spin 守卫
 *
 * 背景：execution-hard-stop-registry.js 覆盖「同一轮内重复 tool-call」；maxRounds/earlyStopPatience 覆盖
 * 「轮数上限 / 分数无改善」。但都拦不住「连续多轮产出一字不差」——maxRounds 很大时白烧 token。
 * 本守卫：产物内容指纹连续 NO_PROGRESS_REPEAT_LIMIT(=2) 次不变 → deriveDecision 提前止损。
 *
 * 覆盖：
 *   1. computeImprovementState：相同产物 → repeatStreak 累加（0→1→2）
 *   2. 产物变化 → repeatStreak 归零
 *   3. 空产物 → 指纹 null + streak 归零（不参与 spin 检测）
 *   4. deriveDecision：repeatStreak>=limit → conclude "no_progress_repeat"
 *   5. repeatStreak<limit → 不提前收敛
 *   6. 本守卫早于 maxRounds：maxRounds 很大时 spin 在 round<maxRounds 就收敛
 *
 * （原第 6 条 no_progress_repeat_failing 已随 evaluationResult 死评价臂整删,
 *   2026-08-26：failing 判定只依赖 evaluationResult.verdict,生产恒 null 不可达。）
 */

import test from "node:test";
import assert from "node:assert/strict";

import { computeImprovementState, deriveDecision } from "../lib/automation/automation-decision.js";

const NOW = 1_000_000;

// ── 1. 相同产物 → repeatStreak 累加 ──────────────────────────────────────────────

test("computeImprovementState：相同产物连续出现 → repeatStreak 0→1→2", () => {
  const spec = { governance: {} };
  const stuck = "完全相同的卡死产物";

  const r1 = computeImprovementState(spec, {}, null, stuck, 1);
  assert.equal(r1.repeatStreak, 0, "首轮无上轮指纹 → streak 0");
  assert.ok(r1.lastArtifactFingerprint, "非空产物应有指纹");

  const r2 = computeImprovementState(
    spec,
    { lastArtifactFingerprint: r1.lastArtifactFingerprint, repeatStreak: r1.repeatStreak },
    null, stuck, 2,
  );
  assert.equal(r2.repeatStreak, 1, "第二轮与上轮相同 → streak 1");

  const r3 = computeImprovementState(
    spec,
    { lastArtifactFingerprint: r2.lastArtifactFingerprint, repeatStreak: r2.repeatStreak },
    null, stuck, 3,
  );
  assert.equal(r3.repeatStreak, 2, "第三轮仍相同 → streak 2");
  assert.equal(r3.lastArtifactFingerprint, r1.lastArtifactFingerprint, "相同产物指纹稳定");
});

// ── 2. 产物变化 → 归零 ───────────────────────────────────────────────────────────

test("computeImprovementState：产物变化 → repeatStreak 归零", () => {
  const spec = { governance: {} };
  const prior = computeImprovementState(spec, {}, null, "旧产物", 1);
  const changed = computeImprovementState(
    spec,
    { lastArtifactFingerprint: prior.lastArtifactFingerprint, repeatStreak: 5 },
    null, "全新的不同产物", 2,
  );
  assert.equal(changed.repeatStreak, 0, "产物不同 → streak 归零");
  assert.notEqual(changed.lastArtifactFingerprint, prior.lastArtifactFingerprint);
});

// ── 3. 空产物不参与 ──────────────────────────────────────────────────────────────

test("computeImprovementState：空/空白产物 → 指纹 null + streak 归零", () => {
  const spec = { governance: {} };
  for (const empty of ["", "   ", null, undefined]) {
    const r = computeImprovementState(spec, { lastArtifactFingerprint: "deadbeef", repeatStreak: 3 }, null, empty, 2);
    assert.equal(r.lastArtifactFingerprint, null, `空产物(${JSON.stringify(empty)}) → 指纹 null`);
    assert.equal(r.repeatStreak, 0, "空产物不参与 spin → streak 归零");
  }
});

test("computeImprovementState：对象产物稳定序列化后比较", () => {
  const spec = { governance: {} };
  const a = computeImprovementState(spec, {}, null, { result: 42, note: "x" }, 1);
  const b = computeImprovementState(
    spec,
    { lastArtifactFingerprint: a.lastArtifactFingerprint, repeatStreak: 0 },
    null, { result: 42, note: "x" }, 2,
  );
  assert.equal(b.repeatStreak, 1, "相同对象产物 → streak 累加");
});

// ── 4. deriveDecision：达阈值 → conclude ─────────────────────────────────────────

test("deriveDecision：repeatStreak>=2 → conclude 'no_progress_repeat'", () => {
  const spec = { enabled: true, governance: { maxRounds: 100 } }; // maxRounds 很大 → 本守卫先于它
  const decision = deriveDecision(spec, {}, {
    round: 3,
    terminalStatus: "completed",
    score: null,
    noImprovementStreak: 0,
    improvementState: { repeatStreak: 2 },
  }, NOW);
  assert.equal(decision.reason, "no_progress_repeat");
  assert.equal(decision.decision, "completed");
  assert.equal(decision.action, "conclude");
});

// ── 5. 未达阈值 → 不提前收敛 ─────────────────────────────────────────────────────

test("deriveDecision：repeatStreak<2 → 不触发 no_progress_repeat", () => {
  const spec = { enabled: true, governance: { maxRounds: 100 } };
  const decision = deriveDecision(spec, {}, {
    round: 2,
    terminalStatus: "completed",
    improvementState: { repeatStreak: 1 },
  }, NOW);
  assert.notEqual(decision.reason, "no_progress_repeat");
});

// ── 6. 本守卫早于 maxRounds（核心价值：maxRounds 大时省 token）───────────────────

test("deriveDecision：maxRounds=100 但 round=3 已 spin → 本守卫先收敛（不等到 round 100）", () => {
  const spec = { enabled: true, governance: { maxRounds: 100 } };
  const decision = deriveDecision(spec, {}, {
    round: 3, // 远未到 maxRounds
    terminalStatus: "completed",
    improvementState: { repeatStreak: 2 },
  }, NOW);
  assert.equal(decision.reason, "no_progress_repeat", "spin 应在 round<<maxRounds 时即收敛");
});
