import test from "node:test";
import assert from "node:assert/strict";

import {
  estimateCliRunTimeoutMs,
  findCliPreset,
  parseCliRunArgs,
  normalizeCliRunTarget,
  resolveCliRunExitCode,
  waitForCliRunCompletion,
} from "../lib/test-runner-cli-client.js";

test("findCliPreset resolves random presets from formal surface payload", () => {
  const preset = findCliPreset({
    presets: [
      { id: "single", label: "单点测试" },
      { id: "user-random-single", label: "随机单点测试", family: "user-random" },
    ],
  }, "user-random-single");

  assert.ok(preset);
  assert.equal(preset.id, "user-random-single");
  assert.equal(preset.family, "user-random");
});

test("normalizeCliRunTarget resolves ad hoc case runs without forcing a preset", () => {
  assert.deepEqual(
    normalizeCliRunTarget({ caseId: "simple-02" }),
    { mode: "case", caseId: "simple-02" },
  );
});

test("normalizeCliRunTarget rejects dual preset and case truth", () => {
  assert.throws(
    () => normalizeCliRunTarget({ presetId: "single", caseId: "simple-02" }),
    /either --preset or --case/i,
  );
});

test("parseCliRunArgs rejects retired suite/filter/clean flags instead of silently running default preset", () => {
  for (const flag of ["--suite", "--filter", "--clean"]) {
    assert.throws(
      () => parseCliRunArgs(["node", "test-runner.js", flag, "legacy"]),
      new RegExp(`retired CLI flag: ${flag}`.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    );
  }
});

test("parseCliRunArgs rejects unknown flags instead of silently running default preset", () => {
  assert.throws(
    () => parseCliRunArgs(["node", "test-runner.js", "--unknown", "value"]),
    /unknown CLI flag: --unknown/i,
  );
});

test("resolveCliRunExitCode returns 2 for blocked-only runs", () => {
  assert.equal(resolveCliRunExitCode({ failedCases: 0, blockedCases: 1 }), 2);
  assert.equal(resolveCliRunExitCode({ failedCases: 1, blockedCases: 0 }), 1);
  assert.equal(resolveCliRunExitCode({ failedCases: 0, blockedCases: 0 }), 0);
});

test("estimateCliRunTimeoutMs scales with preset case count instead of fixed 300000ms", () => {
  const singleTimeout = estimateCliRunTimeoutMs({
    suite: "single",
    caseIds: ["simple-03"],
    resetBetweenCases: false,
  });
  const complexTimeout = estimateCliRunTimeoutMs({
    suite: "single",
    caseIds: ["complex-01", "complex-02", "complex-03"],
    resetBetweenCases: true,
  });

  assert.equal(singleTimeout >= 300000, true);
  assert.equal(complexTimeout > 300000, true);
  assert.equal(complexTimeout > singleTimeout, true);
});

test("waitForCliRunCompletion polls detail endpoint until run reaches terminal state", async () => {
  const calls = [];
  const updates = [];
  const details = [
    { status: "queued", currentCaseId: null },
    { status: "running", currentCaseId: "simple-03" },
    { status: "completed", currentCaseId: null, passedCases: 1, failedCases: 0, blockedCases: 0 },
  ];

  const result = await waitForCliRunCompletion({
    runId: "TR-1",
    requestJSON: async (path) => {
      calls.push(path);
      return details.shift() || { status: "completed", passedCases: 1, failedCases: 0, blockedCases: 0 };
    },
    sleep: async () => {},
    pollIntervalMs: 1,
    timeoutMs: 100,
    onProgress: (detail) => updates.push(`${detail.status}:${detail.currentCaseId || "--"}`),
  });

  assert.equal(result.status, "completed");
  assert.deepEqual(calls, [
    "/watchdog/test-runs/detail?id=TR-1",
    "/watchdog/test-runs/detail?id=TR-1",
    "/watchdog/test-runs/detail?id=TR-1",
  ]);
  assert.deepEqual(updates, [
    "queued:--",
    "running:simple-03",
    "completed:--",
  ]);
});

test("waitForCliRunCompletion treats finalizing as non-terminal", async () => {
  const updates = [];
  const details = [
    { status: "running", currentCaseId: "simple-01", completedCases: 0 },
    { status: "finalizing", currentCaseId: null, completedCases: 1 },
    { status: "completed", currentCaseId: null, completedCases: 1, passedCases: 1, failedCases: 0 },
  ];

  const result = await waitForCliRunCompletion({
    runId: "TR-finalizing",
    requestJSON: async () => details.shift(),
    sleep: async () => {},
    pollIntervalMs: 1,
    timeoutMs: 100,
    onProgress: (detail) => updates.push(detail.status),
  });

  assert.equal(result.status, "completed");
  assert.deepEqual(updates, ["running", "finalizing", "completed"]);
});

test("waitForCliRunCompletion treats cleaning as non-terminal", async () => {
  const updates = [];
  const details = [
    { status: "running", currentCaseId: "simple-01", completedCases: 0 },
    { status: "cleaning", currentCaseId: null, completedCases: 1 },
    { status: "completed", currentCaseId: null, completedCases: 1, passedCases: 1, failedCases: 0 },
  ];

  const result = await waitForCliRunCompletion({
    runId: "TR-cleaning",
    requestJSON: async () => details.shift(),
    sleep: async () => {},
    pollIntervalMs: 1,
    timeoutMs: 100,
    onProgress: (detail) => updates.push(detail.status),
  });

  assert.equal(result.status, "completed");
  assert.deepEqual(updates, ["running", "cleaning", "completed"]);
});
