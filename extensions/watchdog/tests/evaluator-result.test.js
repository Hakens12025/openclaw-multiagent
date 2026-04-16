import test from "node:test";
import assert from "node:assert/strict";
import {
  buildReviewerResult,
  normalizeReviewerResult,
  isPassingReviewerResult,
  mergeReviewerResults,
} from "../lib/harness/reviewer-result.js";

// --- buildReviewerResult basics ---

test("buildReviewerResult returns canonical shape with defaults", () => {
  const result = buildReviewerResult();
  assert.equal(result.verdict, "inconclusive");
  assert.equal(result.source, "manual");
  assert.equal(result.score, null);
  assert.deepEqual(result.findings, []);
  assert.equal(result.failureClass, null);
  assert.equal(result.continueHint, null);
  assert.equal(typeof result.ts, "number");
});

test("buildReviewerResult clamps invalid verdict to inconclusive", () => {
  const result = buildReviewerResult({ verdict: "maybe" });
  assert.equal(result.verdict, "inconclusive");
});

test("buildReviewerResult normalizes findings severity", () => {
  const result = buildReviewerResult({
    findings: [
      { category: "test", severity: "CRITICAL", message: "fail" },
      { category: "test", severity: "bogus", message: "ok" },
    ],
  });
  assert.equal(result.findings[0].severity, "critical");
  assert.equal(result.findings[1].severity, "info");
});

// --- normalizeReviewerResult ---

test("normalizeReviewerResult returns null for empty input", () => {
  assert.equal(normalizeReviewerResult(null), null);
  assert.equal(normalizeReviewerResult({}), null);
  assert.equal(normalizeReviewerResult("string"), null);
});

test("normalizeReviewerResult rebuilds valid input", () => {
  const result = normalizeReviewerResult({ verdict: "pass", score: 85 });
  assert.equal(result.verdict, "pass");
  assert.equal(result.score, 85);
});

// --- isPassingReviewerResult ---

test("isPassingReviewerResult returns true for pass and improved", () => {
  assert.equal(isPassingReviewerResult({ verdict: "pass" }), true);
  assert.equal(isPassingReviewerResult({ verdict: "improved" }), true);
  assert.equal(isPassingReviewerResult({ verdict: "fail" }), false);
  assert.equal(isPassingReviewerResult({ verdict: "inconclusive" }), false);
});

// --- mergeReviewerResults ---

test("mergeReviewerResults uses fail-priority verdict", () => {
  const merged = mergeReviewerResults([
    buildReviewerResult({ verdict: "pass", score: 90 }),
    buildReviewerResult({ verdict: "fail", score: 30 }),
  ]);
  assert.equal(merged.verdict, "fail");
  assert.equal(merged.score, 60);
});

test("mergeReviewerResults uses rework-priority hint", () => {
  const merged = mergeReviewerResults([
    buildReviewerResult({ continueHint: "continue" }),
    buildReviewerResult({ continueHint: "rework" }),
  ]);
  assert.equal(merged.continueHint, "rework");
});

test("mergeReviewerResults flattens findings", () => {
  const merged = mergeReviewerResults([
    buildReviewerResult({ findings: [{ message: "a" }] }),
    buildReviewerResult({ findings: [{ message: "b" }] }),
  ]);
  assert.equal(merged.findings.length, 2);
});

// --- confidence field ---

test("buildReviewerResult accepts confidence field", () => {
  const result = buildReviewerResult({ confidence: 0.85 });
  assert.equal(result.confidence, 0.85);
});

test("buildReviewerResult clamps confidence to 0-1 range", () => {
  assert.equal(buildReviewerResult({ confidence: 1.5 }).confidence, 1.0);
  assert.equal(buildReviewerResult({ confidence: -0.5 }).confidence, 0);
  assert.equal(buildReviewerResult({ confidence: "high" }).confidence, null);
});

test("buildReviewerResult defaults confidence to null", () => {
  const result = buildReviewerResult();
  assert.equal(result.confidence, null);
});

test("mergeReviewerResults averages confidence", () => {
  const merged = mergeReviewerResults([
    buildReviewerResult({ confidence: 0.9 }),
    buildReviewerResult({ confidence: 0.5 }),
  ]);
  assert.equal(merged.confidence, 0.7);
});

// --- findings shape: artifactRef + confidence ---

test("buildReviewerResult normalizes findings with artifactRef and confidence", () => {
  const result = buildReviewerResult({
    findings: [{
      category: "correctness",
      severity: "error",
      message: "variable undefined",
      evidence: "line 42: foo is not defined",
      artifactRef: "stage_result.json",
      confidence: 0.95,
    }],
  });
  const finding = result.findings[0];
  assert.equal(finding.artifactRef, "stage_result.json");
  assert.equal(finding.confidence, 0.95);
});

test("buildReviewerResult defaults finding optional fields to null", () => {
  const result = buildReviewerResult({
    findings: [{ message: "something wrong" }],
  });
  const finding = result.findings[0];
  assert.equal(finding.evidence, null);
  assert.equal(finding.artifactRef, null);
  assert.equal(finding.confidence, null);
});
