import test from "node:test";
import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";

import { FORMAL_TEST_PRESETS, getFormalPresetById } from "../lib/formal-runtime/formal-test-presets.js";
import { resolveRunCleanMode } from "../lib/formal-runtime/test-run-presets.js";
import { resolveSuiteSegments, FULL_SUITE_SEGMENTS } from "../lib/formal-runtime/test-run-suites.js";
import { listTestRuns } from "../lib/formal-runtime/test-runs.js";
import { OC } from "../lib/state.js";

const EXPECTED_PRESET_IDS = [
  "health",
  "model",
  "single",
  "concurrent",
  "pipeline",
  "collab",
  "operator",
  "knowledge",
  "viz",
  "group",
  "unit",
  "full",
];

test("formal preset catalog exposes exactly the 12 approved presets in stable order", () => {
  assert.deepEqual(
    FORMAL_TEST_PRESETS.map((preset) => preset.id),
    EXPECTED_PRESET_IDS,
  );
});

test("health preset is read-only: zero-LLM static suite without clean reset", () => {
  const preset = getFormalPresetById("health");
  assert.ok(preset);
  assert.equal(preset.suite, "health");
  assert.equal(preset.runtimeMode, "static");
  assert.equal(preset.cleanMode, "none");
  assert.equal(preset.resetBetweenCases, false);
  assert.deepEqual(preset.caseIds, ["health-node", "health-gateway"]);
});

test("model preset is a self-targeting live probe over the credentialed provider list", () => {
  const preset = getFormalPresetById("model");
  assert.ok(preset);
  assert.equal(preset.suite, "model");
  assert.equal(preset.runtimeMode, "live");
  assert.equal(preset.transport, "runtime");
  assert.equal(preset.cleanMode, "session-clean");
  assert.deepEqual(preset.caseIds, []);
});

test("single preset targets the two minimal live-link cases", () => {
  const preset = getFormalPresetById("single");
  assert.ok(preset);
  assert.equal(preset.suite, "single");
  assert.equal(preset.cleanMode, "session-clean");
  assert.deepEqual(preset.caseIds, ["answer-direct", "small-file-task"]);
});

test("concurrent preset runs the two race-probe cases with reset between cases", () => {
  const preset = getFormalPresetById("concurrent");
  assert.ok(preset);
  assert.equal(preset.suite, "concurrent");
  assert.equal(preset.runtimeMode, "live");
  assert.equal(preset.transport, "runtime");
  assert.equal(preset.cleanMode, "session-clean");
  assert.equal(preset.resetBetweenCases, true);
  assert.deepEqual(preset.caseIds, ["conc-same-3", "conc-burst-5"]);
});

test("pipeline preset targets the two multi-hop cases", () => {
  const preset = getFormalPresetById("pipeline");
  assert.ok(preset);
  assert.equal(preset.suite, "pipeline");
  assert.deepEqual(preset.caseIds, ["brief-to-deliverable", "research-summary"]);
});

test("retired loop preset is no longer resolvable", () => {
  assert.equal(getFormalPresetById("loop"), null);
  assert.equal(FULL_SUITE_SEGMENTS.includes("loop"), false);
});

test("collab preset runs the layered probes with reset between cases (P5)", () => {
  const preset = getFormalPresetById("collab");
  assert.ok(preset);
  assert.equal(preset.suite, "collab");
  assert.equal(preset.transport, "runtime");
  assert.equal(preset.resetBetweenCases, true);
  assert.deepEqual(preset.caseIds, ["l1-assign-toolface", "l1-assign-expectations", "l1-review-toolface", "l3-marker-review", "create-task-denied"]);
});

test("retired automation-eval preset is no longer resolvable (harness 全退役 v226)", () => {
  assert.equal(getFormalPresetById("automation-eval"), null);
  assert.equal(FULL_SUITE_SEGMENTS.includes("automation-eval"), false);
});

test("operator and knowledge presets are deterministic read-side suites without clean reset", () => {
  for (const presetId of ["operator", "knowledge"]) {
    const preset = getFormalPresetById(presetId);
    assert.ok(preset, presetId);
    assert.equal(preset.suite, presetId);
    assert.equal(preset.runtimeMode, "deterministic");
    assert.equal(preset.cleanMode, "none");
    assert.deepEqual(preset.caseIds, []);
  }
});

test("viz preset is a deterministic read-side chart suite without clean reset", () => {
  const preset = getFormalPresetById("viz");
  assert.ok(preset);
  assert.equal(preset.suite, "viz");
  assert.equal(preset.runtimeMode, "deterministic");
  assert.equal(preset.cleanMode, "none");
  assert.deepEqual(preset.caseIds, []);
});

test("group preset is a deterministic graph-primitive suite without clean reset", () => {
  const preset = getFormalPresetById("group");
  assert.ok(preset);
  assert.equal(preset.suite, "group");
  assert.equal(preset.runtimeMode, "deterministic");
  assert.equal(preset.cleanMode, "none");
  assert.deepEqual(preset.caseIds, []);
});

test("unit preset is a static npm-test wrapper without clean reset", () => {
  const preset = getFormalPresetById("unit");
  assert.ok(preset);
  assert.equal(preset.suite, "unit");
  assert.equal(preset.runtimeMode, "static");
  assert.equal(preset.transport, "none");
  assert.equal(preset.cleanMode, "none");
  assert.deepEqual(preset.caseIds, []);
});

test("full preset expands to all 11 suites serially", () => {
  const preset = getFormalPresetById("full");
  assert.ok(preset);
  assert.equal(preset.suite, "full");
  assert.deepEqual(resolveSuiteSegments(preset), [...FULL_SUITE_SEGMENTS]);
  assert.deepEqual(preset.caseIds, [...FULL_SUITE_SEGMENTS]);
});

test("every preset suite key resolves to dispatchable segments", () => {
  for (const preset of FORMAL_TEST_PRESETS) {
    const segments = resolveSuiteSegments(preset);
    assert.ok(segments.length >= 1, `${preset.id} resolves no segments`);
    for (const segment of segments) {
      assert.ok(FULL_SUITE_SEGMENTS.includes(segment), `${preset.id} → unknown segment ${segment}`);
    }
  }
});

test("preset cleanMode is the single truth: requested session-clean cannot force-reset a none preset", () => {
  assert.equal(resolveRunCleanMode(getFormalPresetById("health"), "session-clean"), "none");
  assert.equal(resolveRunCleanMode(getFormalPresetById("single"), ""), "session-clean");
  assert.throws(() => resolveRunCleanMode(getFormalPresetById("single"), "bogus"), /unsupported test run cleanMode/);
});

test("devtools preset listing mirrors the formal preset catalog", () => {
  const listed = listTestRuns().presets.map((preset) => preset.id);
  assert.deepEqual(listed, EXPECTED_PRESET_IDS);
});

test("devtools preset listing keeps the payload field-name contract", () => {
  for (const preset of listTestRuns().presets) {
    for (const field of [
      "id",
      "label",
      "description",
      "suite",
      "family",
      "runtimeMode",
      "transport",
      "cleanMode",
      "caseIds",
      "resetBetweenCases",
    ]) {
      assert.ok(field in preset, `preset ${preset.id} missing field ${field}`);
    }
    assert.ok(Array.isArray(preset.caseIds));
  }
});

test("formal runtime runner does not import suite implementations from tests", async () => {
  const source = await readFile(join(OC, "extensions", "watchdog", "lib", "formal-runtime", "test-runs.js"), "utf8");

  assert.doesNotMatch(source, /\.\.\/tests\/suite-/);
});

test("formal runtime settle wait uses registered work agents instead of legacy role-name matching", async () => {
  const source = await readFile(join(OC, "extensions", "watchdog", "lib", "formal-runtime", "infra.js"), "utf8");

  assert.doesNotMatch(source, /worker\/contractor/);
  assert.doesNotMatch(source, /\.includes\("contractor"\)/);
  assert.doesNotMatch(source, /\.includes\("evaluator"\)/);
  assert.doesNotMatch(source, /\.includes\("researcher"\)/);
});

test("formal runtime has no tests-directory re-export facade files", async () => {
  const retiredFacadeFiles = [
    "infra.js",
    "formal-report.js",
    "test-locks.js",
    "suite-health.js",
    "suite-link.js",
    "suite-loop.js",
    "suite-system-action.js",
    "suite-operator.js",
    "suite-knowledge.js",
  ];

  for (const fileName of retiredFacadeFiles) {
    await assert.rejects(
      access(join(OC, "extensions", "watchdog", "tests", fileName)),
      `${fileName} should live only under lib/formal-runtime`,
    );
  }
});

test("retired old-system modules stay deleted", async () => {
  const retiredModules = [
    join("lib", "formal-test-case-catalog.js"),
    join("lib", "formal-test-qq-target.js"),
    join("lib", "test-run-random-runtime.js"),
    join("lib", "formal-runtime", "suite-single.js"),
    join("lib", "formal-runtime", "suite-direct-service.js"),
    join("lib", "formal-runtime", "suite-loop-direct.js"),
    join("lib", "formal-runtime", "suite-loop.js"),
    join("lib", "formal-runtime", "suite-automation-eval.js"),
    join("lib", "formal-runtime", "checks", "harness-probe.js"),
    join("lib", "loop"),
    join("lib", "harness"),
    join("lib", "formal-runtime", "tsp"),
  ];

  for (const relPath of retiredModules) {
    await assert.rejects(
      access(join(OC, "extensions", "watchdog", relPath)),
      `${relPath} should stay deleted`,
    );
  }
});
