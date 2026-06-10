import test from "node:test";
import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";

import { FORMAL_TEST_PRESETS, getFormalPresetById } from "../lib/formal-test-presets.js";
import { resolveRunCleanMode } from "../lib/test-run-presets.js";
import { resolveSuiteSegments, FULL_SUITE_SEGMENTS } from "../lib/test-run-suites.js";
import { listTestRuns } from "../lib/test-runs.js";
import { OC } from "../lib/state.js";

const EXPECTED_PRESET_IDS = [
  "health",
  "dispatch",
  "pipeline",
  "loop",
  "system-action",
  "operator",
  "knowledge",
  "full",
];

test("formal preset catalog exposes exactly the 8 approved presets in stable order", () => {
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

test("dispatch preset targets the two minimal live-link cases", () => {
  const preset = getFormalPresetById("dispatch");
  assert.ok(preset);
  assert.equal(preset.suite, "dispatch");
  assert.equal(preset.cleanMode, "session-clean");
  assert.deepEqual(preset.caseIds, ["answer-direct", "small-file-task"]);
});

test("pipeline preset targets the two multi-hop cases", () => {
  const preset = getFormalPresetById("pipeline");
  assert.ok(preset);
  assert.equal(preset.suite, "pipeline");
  assert.deepEqual(preset.caseIds, ["brief-to-deliverable", "research-summary"]);
});

test("loop preset is self-targeting via graph truth (no static caseIds)", () => {
  const preset = getFormalPresetById("loop");
  assert.ok(preset);
  assert.equal(preset.suite, "loop");
  assert.deepEqual(preset.caseIds, []);
});

test("system-action preset runs the three [ACTION] probes with reset between cases", () => {
  const preset = getFormalPresetById("system-action");
  assert.ok(preset);
  assert.equal(preset.suite, "system-action");
  assert.equal(preset.transport, "runtime");
  assert.equal(preset.resetBetweenCases, true);
  assert.deepEqual(preset.caseIds, ["create-task", "assign-task", "request-review"]);
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

test("full preset expands to all 7 suites serially", () => {
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
  assert.equal(resolveRunCleanMode(getFormalPresetById("dispatch"), ""), "session-clean");
  assert.throws(() => resolveRunCleanMode(getFormalPresetById("dispatch"), "bogus"), /unsupported test run cleanMode/);
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
  const source = await readFile(join(OC, "extensions", "watchdog", "lib", "test-runs.js"), "utf8");

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
    join("lib", "formal-runtime", "tsp"),
  ];

  for (const relPath of retiredModules) {
    await assert.rejects(
      access(join(OC, "extensions", "watchdog", relPath)),
      `${relPath} should stay deleted`,
    );
  }
});
