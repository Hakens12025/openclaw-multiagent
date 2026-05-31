import test from "node:test";
import assert from "node:assert/strict";
import { readFile, rm, access } from "node:fs/promises";
import { join } from "node:path";

import { OC } from "../lib/state-paths.js";
import {
  shouldPrecipitateSkill,
  extractCausalSkill,
  precipitateSkill,
  maybePrecipitateSkillFromRound,
} from "../lib/automation/automation-skill-precipitation.js";

// ④ skill 因果链自动沉淀：代码判评判（EvaluationResult 阈值 + ProfileLifecycle streak + gate），
// 只留验证后因果（Pro 挂成功 harnessRunId / Con 挂失败 failureClass，无证据不编）。

// 用唯一 throwaway profileId 避免污染真 skills 库；测试后清理 learned-* 目录。
const TEST_PROFILE = `test.precipitation.${process.pid}`;
const TEST_SKILL_DIR = join(OC, "skills", `learned-${TEST_PROFILE}`);

function buildSpec() {
  return { id: "auto-test", harness: { profileId: TEST_PROFILE, scoreMax: 1 }, objective: { summary: "fix bug" } };
}
function buildSuccessRun() {
  return {
    id: "harness:auto-test:round:3:ts:1",
    profileId: TEST_PROFILE,
    gateSummary: { failed: 0, passed: 2, verdict: "passed" },
    summary: "patched and tests pass",
    moduleRuns: [
      { moduleId: "gate.test", kind: "gate", status: "passed", summary: "all tests green", evidence: { testSignal: { signal: "green" } } },
    ],
  };
}
function buildFailedFamilyRun() {
  return {
    id: "harness:auto-test:round:2:ts:0",
    profileId: TEST_PROFILE,
    terminalStatus: "failed",
    gateSummary: { failed: 1, verdict: "failed" },
    moduleRuns: [
      { moduleId: "normalizer.failure", kind: "normalizer", status: "failed", evidence: { failureClass: "review_rejected" } },
    ],
  };
}

test.afterEach(async () => {
  await rm(TEST_SKILL_DIR, { recursive: true, force: true });
});

// ── 评判：代码判（非 LLM 自评）────────────────────────────────────────────────

test("shouldPrecipitateSkill: pass+score>=threshold+streak>=2+gate passed -> precipitate", () => {
  const r = shouldPrecipitateSkill({
    spec: buildSpec(), evaluationResult: { id: "er-1", verdict: "pass", score: 0.9 },
    profileLifecycle: { successStreak: 3 }, harnessRun: buildSuccessRun(),
  });
  assert.equal(r.precipitate, true);
  assert.equal(r.reason, "verified_success");
});

test("shouldPrecipitateSkill: streak below min blocks (no one-shot luck)", () => {
  const r = shouldPrecipitateSkill({
    spec: buildSpec(), evaluationResult: { id: "er-1", verdict: "pass", score: 0.9 },
    profileLifecycle: { successStreak: 1 }, harnessRun: buildSuccessRun(),
  });
  assert.equal(r.precipitate, false);
  assert.match(r.reason, /streak_below_min/);
});

test("shouldPrecipitateSkill: non-success verdict blocks", () => {
  const r = shouldPrecipitateSkill({
    spec: buildSpec(), evaluationResult: { id: "er-1", verdict: "fail", score: 0.9 },
    profileLifecycle: { successStreak: 5 }, harnessRun: buildSuccessRun(),
  });
  assert.equal(r.precipitate, false);
  assert.match(r.reason, /verdict_not_success/);
});

test("shouldPrecipitateSkill: gate failed blocks even with good verdict", () => {
  const r = shouldPrecipitateSkill({
    spec: buildSpec(), evaluationResult: { id: "er-1", verdict: "pass", score: 0.9 },
    profileLifecycle: { successStreak: 5 }, harnessRun: { ...buildSuccessRun(), gateSummary: { failed: 1, verdict: "failed" } },
  });
  assert.equal(r.precipitate, false);
  assert.equal(r.reason, "gate_not_passed");
});

test("shouldPrecipitateSkill: automation without harness.profileId is not precipitated (no ephemeral one-off skills)", () => {
  const r = shouldPrecipitateSkill({
    spec: { id: "ephemeral-auto", harness: { moduleRefs: ["harness:gate.artifact"] } }, // no profileId
    evaluationResult: { id: "er-1", verdict: "pass", score: 0.9 },
    profileLifecycle: { successStreak: 5 }, harnessRun: { ...buildSuccessRun(), profileId: null },
  });
  assert.equal(r.precipitate, false);
  assert.equal(r.reason, "no_profile_id");
});

test("extractCausalSkill returns null without a harness.profileId (skills attach to task families)", () => {
  const skill = extractCausalSkill({
    spec: { id: "ephemeral-auto", harness: {} },
    harnessRun: { ...buildSuccessRun(), profileId: null },
    evaluationResult: { id: "er-1", verdict: "pass", score: 0.9 },
    recentHarnessRuns: [],
  });
  assert.equal(skill, null);
});

test("shouldPrecipitateSkill: low score blocks", () => {
  const r = shouldPrecipitateSkill({
    spec: buildSpec(), evaluationResult: { id: "er-1", verdict: "pass", score: 0.3 },
    profileLifecycle: { successStreak: 5 }, harnessRun: buildSuccessRun(),
  });
  assert.equal(r.precipitate, false);
  assert.match(r.reason, /score_below_threshold/);
});

test("shouldPrecipitateSkill: disabled via spec.skillPrecipitation.enabled=false", () => {
  const spec = { ...buildSpec(), skillPrecipitation: { enabled: false } };
  const r = shouldPrecipitateSkill({
    spec, evaluationResult: { id: "er-1", verdict: "pass", score: 0.9 },
    profileLifecycle: { successStreak: 5 }, harnessRun: buildSuccessRun(),
  });
  assert.equal(r.precipitate, false);
  assert.equal(r.reason, "disabled");
});

// ── 抽因果对：Pro 挂成功 evidence / Con 挂失败 failureClass / 无证据不编 ──────────

test("extractCausalSkill: Pro carries harnessRunId, Con carries failureClass", () => {
  const skill = extractCausalSkill({
    spec: buildSpec(), harnessRun: buildSuccessRun(),
    evaluationResult: { id: "er-1", verdict: "pass", score: 0.9 },
    recentHarnessRuns: [buildFailedFamilyRun()],
  });
  assert.ok(skill);
  assert.equal(skill.profileId, TEST_PROFILE);
  // Pro 挂成功 harnessRunId
  assert.ok(skill.pros.length >= 1);
  assert.equal(skill.pros[0].evidence.harnessRunId, "harness:auto-test:round:3:ts:1");
  // Con 挂失败 failureClass
  assert.ok(skill.cons.length >= 1);
  assert.equal(skill.cons[0].evidence.failureClass, "review_rejected");
  assert.equal(skill.cons[0].evidence.harnessRunId, "harness:auto-test:round:2:ts:0");
  assert.ok(skill.originHash);
});

test("extractCausalSkill: Con empty when no failure evidence (only verified, no fabrication)", () => {
  const skill = extractCausalSkill({
    spec: buildSpec(), harnessRun: buildSuccessRun(),
    evaluationResult: { id: "er-1", verdict: "pass", score: 0.9 },
    recentHarnessRuns: [],
  });
  assert.ok(skill);
  assert.deepEqual(skill.cons, [], "no failure evidence -> Con stays empty, never invented");
});

test("extractCausalSkill: no Pro evidence -> no skill (verified Pro is required)", () => {
  const skill = extractCausalSkill({
    spec: buildSpec(),
    harnessRun: { id: null, gateSummary: {}, moduleRuns: [] }, // no passed modules, no runId
    evaluationResult: { id: "er-1", verdict: "pass", score: 0.9 },
    recentHarnessRuns: [],
  });
  assert.equal(skill, null, "without Pro evidence, nothing is precipitated");
});

// ── 写 SKILL.md + SOURCE.json + 去重 ───────────────────────────────────────────

test("precipitateSkill writes SKILL.md with When/Pro/Con + evidence, and SOURCE.json metadata", async () => {
  const skill = extractCausalSkill({
    spec: buildSpec(), harnessRun: buildSuccessRun(),
    evaluationResult: { id: "er-1", evaluationResultId: "er-1", verdict: "pass", score: 0.9 },
    recentHarnessRuns: [buildFailedFamilyRun()],
  });
  const result = await precipitateSkill({ skill });
  assert.equal(result.written, true);

  const md = await readFile(join(TEST_SKILL_DIR, "SKILL.md"), "utf8");
  assert.match(md, /## 情况（When）/);
  assert.match(md, /## Pro（对/);
  assert.match(md, /## Con（错/);
  assert.match(md, /harness:auto-test:round:3:ts:1/, "Pro evidence harnessRunId in markdown");
  assert.match(md, /review_rejected/, "Con evidence failureClass in markdown");

  const source = JSON.parse(await readFile(join(TEST_SKILL_DIR, "SOURCE.json"), "utf8"));
  assert.equal(source.harnessRunId, "harness:auto-test:round:3:ts:1");
  assert.equal(source.evaluationResultId, "er-1");
  assert.equal(source.originHash, skill.originHash);
});

test("precipitateSkill dedups by originHash (second identical write skipped)", async () => {
  const buildSkill = () => extractCausalSkill({
    spec: buildSpec(), harnessRun: buildSuccessRun(),
    evaluationResult: { id: "er-1", verdict: "pass", score: 0.9 },
    recentHarnessRuns: [buildFailedFamilyRun()],
  });
  const first = await precipitateSkill({ skill: buildSkill() });
  assert.equal(first.written, true);
  const second = await precipitateSkill({ skill: buildSkill() });
  assert.equal(second.written, false);
  assert.equal(second.reason, "duplicate_origin_hash");
});

// ── 编排：maybePrecipitateSkillFromRound + onAlert SKILL_PRECIPITATED ───────────

test("maybePrecipitateSkillFromRound emits skill_precipitated alert on success", async () => {
  const alerts = [];
  const out = await maybePrecipitateSkillFromRound({
    spec: buildSpec(), harnessRun: buildSuccessRun(),
    evaluationResult: { id: "er-1", verdict: "pass", score: 0.9 },
    profileLifecycle: { successStreak: 3 },
    recentHarnessRuns: [buildFailedFamilyRun()],
    onAlert: (a) => alerts.push(a),
  });
  assert.equal(out.precipitated, true);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].type, "skill_precipitated");
  assert.equal(alerts[0].skillName, `learned-${TEST_PROFILE}`);
  assert.ok(alerts[0].harnessRunId, "alert carries evidence linkage");
});

test("maybePrecipitateSkillFromRound is a no-op (no alert) when threshold not met", async () => {
  const alerts = [];
  const out = await maybePrecipitateSkillFromRound({
    spec: buildSpec(), harnessRun: buildSuccessRun(),
    evaluationResult: { id: "er-1", verdict: "pass", score: 0.9 },
    profileLifecycle: { successStreak: 1 }, // below min
    recentHarnessRuns: [],
    onAlert: (a) => alerts.push(a),
  });
  assert.equal(out.precipitated, false);
  assert.match(out.reason, /streak_below_min/);
  assert.equal(alerts.length, 0);
});
