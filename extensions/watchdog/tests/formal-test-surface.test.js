import test from "node:test";
import assert from "node:assert/strict";

import { FORMAL_TEST_PRESETS, getFormalPresetById } from "../lib/formal-test-presets.js";
import { listTestRuns } from "../lib/test-runs.js";
import { generateReport } from "./suite-single.js";

const EXPECTED_PRESET_IDS = [
  "single",
  "complex",
  "multi",
  "simple-batch",
  "user-random-single",
  "user-random-complex",
  "system-random-single",
  "system-random-complex",
  "loop-random-single",
  "loop-random-complex",
  "concurrent",
  "mixed-concurrency",
  "queue-pressure",
  "loop-platform",
  "direct-service",
  "direct-service-full",
];

test("formal preset catalog exposes the approved formal presets in stable order", () => {
  assert.deepEqual(
    FORMAL_TEST_PRESETS.map((preset) => preset.id),
    EXPECTED_PRESET_IDS,
  );
});

test("formal complex preset targets all three complex template cases with reset", () => {
  const preset = getFormalPresetById("complex");
  assert.ok(preset);
  assert.equal(preset.suite, "single");
  assert.equal(preset.resetBetweenCases, true);
  assert.deepEqual(preset.caseIds, ["complex-01", "complex-02", "complex-03"]);
});

test("formal direct-service preset points only at the assign-task return case", () => {
  const preset = getFormalPresetById("direct-service");
  assert.ok(preset);
  assert.equal(preset.suite, "direct-service");
  assert.deepEqual(preset.caseIds, ["direct-service-assign-task-return"]);
});

test("formal multi preset resets between independent template cases", () => {
  const preset = getFormalPresetById("multi");
  assert.ok(preset);
  assert.equal(preset.suite, "single");
  assert.equal(preset.resetBetweenCases, true);
});

test("formal queue-pressure preset targets only concurrent queue stress groups", () => {
  const preset = getFormalPresetById("queue-pressure");
  assert.ok(preset);
  assert.equal(preset.suite, "concurrent");
  assert.equal(preset.resetBetweenCases, true);
  assert.deepEqual(preset.caseIds, ["conc-same-3", "conc-4s-queue"]);
});

test("formal direct-service-full preset runs the full direct-service matrix", () => {
  const preset = getFormalPresetById("direct-service-full");
  assert.ok(preset);
  assert.equal(preset.suite, "direct-service");
  assert.equal(preset.resetBetweenCases, true);
  assert.deepEqual(preset.caseIds, [
    "direct-service-create-task-return",
    "direct-service-assign-task-return",
    "direct-service-request-review-return",
  ]);
});

test("formal random presets expose family metadata and runtime mode", () => {
  const preset = getFormalPresetById("user-random-single");
  assert.ok(preset);
  assert.equal(preset.family, "user-random");
  assert.equal(preset.runtimeMode, "random");
});

test("devtools preset listing mirrors the formal preset catalog", () => {
  const listed = listTestRuns().presets.map((preset) => preset.id);
  assert.deepEqual(listed, EXPECTED_PRESET_IDS);
});

test("formal reports expose normalized section headers", () => {
  const report = generateReport([
    {
      pass: true,
      blocked: false,
      duration: "3.2",
      isFastTrack: true,
      contractId: "TEST-CONTRACT-1",
      testCase: {
        id: "simple-formal",
        message: "你好",
        scenario: "标准 WebUI 单请求",
        businessSemantics: "验证标准 WebUI 单请求主链路",
        transportPath: ["ingress.normalize", "conveyor.dispatch", "lifecycle.commit"],
        expectedRuntimeTruth: ["contract created", "worker completed", "delivery committed"],
        coverage: ["ingress", "dispatch", "execution", "delivery", "frontend_visibility"],
      },
      results: [
        {
          at: 1,
          id: 1,
          name: "Hook hardpath",
          status: "PASS",
          elapsed: "0.2",
          detail: "ingress ok",
        },
      ],
      contractRuntime: {
        status: "completed",
        taskType: "request",
      },
    },
  ], "single", "3.2");

  assert.match(report, /SUMMARY/);
  assert.match(report, /EVENT TIMELINE/);
  assert.match(report, /RESULT/);
  assert.match(report, /OPENCLAW TEST REPORT/);
});

test("formal reports render random runtime facts when present", () => {
  const report = generateReport([
    {
      pass: false,
      blocked: true,
      duration: "1.2",
      testCase: {
        id: "simple-03",
        message: "你好",
      },
      randomRuntime: {
        family: "user-random",
        seed: "seed-fixed",
        chosenAgent: "worker-x",
        actualPath: "direct_request",
        pathVerdictReason: "fell back to direct session",
      },
      results: [],
    },
  ], "single", "1.2");

  assert.match(report, /chosenAgent: worker-x/);
  assert.match(report, /actualPath: direct_request/);
  assert.match(report, /1 BLOCKED/);
});
