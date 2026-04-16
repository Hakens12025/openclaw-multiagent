import test from "node:test";
import assert from "node:assert/strict";
import { buildReviewContext } from "../lib/review-context-builder.js";
import { buildReviewerResult } from "../lib/harness/reviewer-result.js";

test("buildReviewContext extracts cross-round signals from automation runtime state", () => {
  const lastResult = buildReviewerResult({ verdict: "fail", score: 45 });
  const ctx = buildReviewContext({
    automationRuntimeState: {
      automationId: "AUTO-1",
      currentRound: 3,
      lastScore: 45,
      bestScore: 72,
      noImprovementStreak: 2,
      lastReviewerResult: lastResult,
    },
    contractContext: {
      round: 3,
    },
    artifacts: [
      { path: "/tmp/output.md", label: "primary_artifact" },
    ],
  });

  assert.equal(ctx.round, 3);
  assert.equal(ctx.previousVerdict, "fail");
  assert.equal(ctx.previousScore, 45);
  assert.equal(ctx.bestSoFarScore, 72);
  assert.equal(ctx.noImprovementStreak, 2);
  assert.equal(ctx.artifacts.length, 1);
  assert.equal(ctx.artifacts[0].path, "/tmp/output.md");
  assert.equal(typeof ctx.ts, "number");
});

test("buildReviewContext returns safe defaults when runtime state is missing", () => {
  const ctx = buildReviewContext({
    automationRuntimeState: null,
    contractContext: null,
    artifacts: null,
  });

  assert.equal(ctx.round, null);
  assert.equal(ctx.previousVerdict, null);
  assert.equal(ctx.previousScore, null);
  assert.equal(ctx.bestSoFarScore, null);
  assert.equal(ctx.noImprovementStreak, 0);
  assert.deepEqual(ctx.artifacts, []);
});

test("buildReviewContext prefers contractContext.round over runtimeState.currentRound", () => {
  const ctx = buildReviewContext({
    automationRuntimeState: { currentRound: 5 },
    contractContext: { round: 6 },
  });
  assert.equal(ctx.round, 6);
});
