import test from "node:test";
import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";

import { FORMAL_TEST_PRESETS, getFormalPresetById } from "../lib/formal-test-presets.js";
import { listTestRuns } from "../lib/test-runs.js";
import { generateReport } from "../lib/formal-runtime/suite-single.js";
import { OC } from "../lib/state.js";

const EXPECTED_PRESET_IDS = [
  "single",
  "qq-single",
  "qq-weekday",
  "qq-simple-batch",
  "qq-complex",
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
  "direct-service",
  "direct-service-matrix",
];

test("formal preset catalog exposes the approved formal presets in stable order", () => {
  assert.deepEqual(
    FORMAL_TEST_PRESETS.map((preset) => preset.id),
    EXPECTED_PRESET_IDS,
  );
});

test("formal qq-simple-batch preset runs the three light cases over QQ with reset", () => {
  const preset = getFormalPresetById("qq-simple-batch");
  assert.ok(preset);
  assert.equal(preset.suite, "single");
  assert.equal(preset.transport, "qq");
  assert.equal(preset.resetBetweenCases, true);
  assert.deepEqual(preset.caseIds, ["simple-01", "simple-02", "simple-03"]);
});

test("formal qq-complex preset runs the three complex cases over QQ with reset", () => {
  const preset = getFormalPresetById("qq-complex");
  assert.ok(preset);
  assert.equal(preset.suite, "single");
  assert.equal(preset.transport, "qq");
  assert.equal(preset.resetBetweenCases, true);
  assert.deepEqual(preset.caseIds, ["complex-01", "complex-02", "complex-03"]);
});

test("formal complex preset targets all three complex template cases with reset", () => {
  const preset = getFormalPresetById("complex");
  assert.ok(preset);
  assert.equal(preset.suite, "single");
  assert.equal(preset.resetBetweenCases, true);
  assert.deepEqual(preset.caseIds, ["complex-01", "complex-02", "complex-03"]);
});

test("formal qq-single preset uses QQ transport for the standard single case", () => {
  const preset = getFormalPresetById("qq-single");
  assert.ok(preset);
  assert.equal(preset.suite, "single");
  assert.equal(preset.transport, "qq");
  assert.equal(preset.resetBetweenCases, false);
  assert.deepEqual(preset.caseIds, ["simple-03"]);
});

test("formal qq-weekday preset uses QQ transport for the weekday case", () => {
  const preset = getFormalPresetById("qq-weekday");
  assert.ok(preset);
  assert.equal(preset.suite, "single");
  assert.equal(preset.transport, "qq");
  assert.equal(preset.resetBetweenCases, false);
  assert.deepEqual(preset.caseIds, ["simple-01"]);
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

test("formal direct-service-matrix preset runs the direct-service matrix", () => {
  const preset = getFormalPresetById("direct-service-matrix");
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

test("devtools preset listing exposes timeout-critical preset metadata", () => {
  const complex = listTestRuns().presets.find((preset) => preset.id === "complex");
  assert.deepEqual(complex?.caseIds, ["complex-01", "complex-02", "complex-03"]);
  assert.equal(complex?.resetBetweenCases, true);
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
    "suite-single.js",
    "suite-loop.js",
    "suite-loop-direct.js",
    "suite-direct-service.js",
  ];

  for (const fileName of retiredFacadeFiles) {
    await assert.rejects(
      access(join(OC, "extensions", "watchdog", "tests", fileName)),
      `${fileName} should live only under lib/formal-runtime`,
    );
  }
});

test("formal reports expose normalized section headers", () => {
  const report = generateReport([
    {
      pass: true,
      blocked: false,
      duration: "3.2",
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
        pathVerdictReason: "fell back to topology-free direct intake",
      },
      results: [],
    },
  ], "single", "1.2");

  assert.match(report, /chosenAgent: worker-x/);
  assert.match(report, /actualPath: direct_request/);
  assert.match(report, /1 BLOCKED/);
});

test("formal reports render incident-backed runtime fault truth when present", () => {
  const report = generateReport([
    {
      pass: false,
      blocked: false,
      duration: "1.2",
      testCase: {
        id: "simple-fault",
        message: "今天星期几",
      },
      incident: {
        rootFault: "mixed_fault",
        firstFaultCode: "identical_tool_loop",
        amplifiers: ["wrong_actor_activation"],
      },
      results: [],
    },
  ], "single", "1.2");

  assert.match(report, /rootFault: mixed_fault/);
  assert.match(report, /firstFault: identical_tool_loop/);
});
