import test from "node:test";
import assert from "node:assert/strict";

import {
  findCliPreset,
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

test("resolveCliRunExitCode returns 2 for blocked-only runs", () => {
  assert.equal(resolveCliRunExitCode({ failedCases: 0, blockedCases: 1 }), 2);
  assert.equal(resolveCliRunExitCode({ failedCases: 1, blockedCases: 0 }), 1);
  assert.equal(resolveCliRunExitCode({ failedCases: 0, blockedCases: 0 }), 0);
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
