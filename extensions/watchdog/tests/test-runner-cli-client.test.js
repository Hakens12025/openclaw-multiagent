// test-runner-cli-client.test.js — CLI 纯逻辑单测（参数解析/超时预算/轮询/--list 渲染）
// 预设真值在 live surface，CLI 不写死 preset id；本文件 fixture 使用新 8 预设词汇。

import test from "node:test";
import assert from "node:assert/strict";

import {
  CLI_USAGE,
  estimateCliRunTimeoutMs,
  findCliPreset,
  formatCliPresetTable,
  parseCliRunArgs,
  normalizeCliRunTarget,
  resolveCliRunExitCode,
  waitForCliRunCompletion,
} from "../lib/formal-runtime/test-runner-cli-client.js";

test("findCliPreset resolves presets from live surface payload", () => {
  const preset = findCliPreset({
    presets: [
      { id: "health", label: "系统健康体检", suite: "health" },
      { id: "single", label: "链路单点", suite: "single", family: "live" },
    ],
  }, "single");

  assert.ok(preset);
  assert.equal(preset.id, "single");
  assert.equal(preset.family, "live");
  assert.equal(findCliPreset({ presets: [] }, "single"), null);
});

test("normalizeCliRunTarget defaults to the health preset when nothing requested", () => {
  assert.deepEqual(normalizeCliRunTarget({}), { mode: "preset", presetId: "health" });
  assert.deepEqual(normalizeCliRunTarget(), { mode: "preset", presetId: "health" });
});

test("normalizeCliRunTarget resolves ad hoc case runs without forcing a preset", () => {
  assert.deepEqual(
    normalizeCliRunTarget({ caseId: "answer-direct" }),
    { mode: "case", caseId: "answer-direct" },
  );
});

test("normalizeCliRunTarget rejects dual preset and case truth", () => {
  assert.throws(
    () => normalizeCliRunTarget({ presetId: "single", caseId: "answer-direct" }),
    /either --preset or --case/i,
  );
});

test("normalizeCliRunTarget maps list/help requests to dedicated modes", () => {
  assert.deepEqual(normalizeCliRunTarget({ list: true }), { mode: "list" });
  assert.deepEqual(normalizeCliRunTarget({ help: true }), { mode: "help" });
  // help 优先于 list（--help --list 同给时打印说明即可）
  assert.deepEqual(normalizeCliRunTarget({ list: true, help: true }), { mode: "help" });
});

test("parseCliRunArgs parses --list/--help as boolean flags", () => {
  assert.deepEqual(
    parseCliRunArgs(["node", "test-runner.js", "--list"]),
    { presetId: "", caseId: "", list: true, help: false },
  );
  assert.deepEqual(
    parseCliRunArgs(["node", "test-runner.js", "--help"]),
    { presetId: "", caseId: "", list: false, help: true },
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

test("parseCliRunArgs requires values for --preset/--case", () => {
  assert.throws(
    () => parseCliRunArgs(["node", "test-runner.js", "--preset"]),
    /missing value for --preset/i,
  );
  assert.throws(
    () => parseCliRunArgs(["node", "test-runner.js", "--case", "--list"]),
    /missing value for --case/i,
  );
});

test("CLI_USAGE documents the new surface: default health + list/help + retired flags", () => {
  assert.match(CLI_USAGE, /--list/);
  assert.match(CLI_USAGE, /--help/);
  assert.match(CLI_USAGE, /"health"/);
  assert.match(CLI_USAGE, /--suite\/--filter\/--clean/);
});

test("formatCliPresetTable renders live payload rows with case ids", () => {
  const table = formatCliPresetTable({
    presets: [
      {
        id: "health",
        suite: "health",
        cleanMode: "none",
        caseIds: ["health-node", "health-gateway"],
        label: "系统健康体检",
        description: "零 LLM 体检",
      },
      { id: "collab", suite: "collab", cleanMode: "session-clean", caseIds: [], description: "系统动作探针" },
    ],
  });

  assert.match(table, /PRESET\s+SUITE\s+CLEANMODE\s+DESCRIPTION/);
  assert.match(table, /health\s+health\s+none\s+系统健康体检 — 零 LLM 体检/);
  assert.match(table, /cases: health-node,health-gateway/);
  assert.match(table, /collab\s+collab\s+session-clean\s+系统动作探针/);
  assert.equal(formatCliPresetTable({ presets: [] }), "(no presets exposed by gateway)");
});

test("resolveCliRunExitCode returns 2 for blocked-only runs", () => {
  assert.equal(resolveCliRunExitCode({ failedCases: 0, blockedCases: 1 }), 2);
  assert.equal(resolveCliRunExitCode({ failedCases: 1, blockedCases: 0 }), 1);
  assert.equal(resolveCliRunExitCode({ failedCases: 0, blockedCases: 0 }), 0);
});

test("estimateCliRunTimeoutMs uses per-suite budgets (health fast, pipeline slow, full per-segment)", () => {
  const healthTimeout = estimateCliRunTimeoutMs({
    suite: "health",
    caseIds: ["health-node", "health-gateway"],
    resetBetweenCases: false,
  });
  const pipelineTimeout = estimateCliRunTimeoutMs({ suite: "pipeline", caseIds: [], resetBetweenCases: false });
  const fullTimeout = estimateCliRunTimeoutMs({
    suite: "full",
    caseIds: ["health", "model", "single", "pipeline", "collab", "operator", "knowledge"],
    resetBetweenCases: false,
  });

  // health: 2 段 × 120s + 120s finalization = 360s（仍 >= 最小 300s）
  assert.equal(healthTimeout, 360000);
  // pipeline: 无 caseIds → 1 段 × 480s + 120s
  assert.equal(pipelineTimeout, 600000);
  // full: 7 段 × 600s + 120s — 必须显著大于单段
  assert.equal(fullTimeout, 7 * 600000 + 120000);
  assert.ok(fullTimeout > pipelineTimeout);
  assert.ok(pipelineTimeout > healthTimeout);
});

test("estimateCliRunTimeoutMs adds reset allowance and respects the 300s floor", () => {
  const withReset = estimateCliRunTimeoutMs({
    suite: "collab",
    caseIds: ["l1-assign-toolface", "l1-review-toolface", "l3-marker-review", "create-task-denied"],
    resetBetweenCases: true,
  });
  const withoutReset = estimateCliRunTimeoutMs({
    suite: "collab",
    caseIds: ["l1-assign-toolface", "l1-review-toolface", "l3-marker-review", "create-task-denied"],
    resetBetweenCases: false,
  });
  assert.equal(withReset - withoutReset, 3 * 45000);

  // 未知 suite 退默认预算；任何结果不得低于 300s 地板
  const floor = estimateCliRunTimeoutMs({ suite: "health", caseIds: ["solo"], resetBetweenCases: false });
  assert.ok(floor >= 300000);
});

test("waitForCliRunCompletion polls detail endpoint until run reaches terminal state", async () => {
  const calls = [];
  const updates = [];
  const details = [
    { status: "queued", currentCaseId: null },
    { status: "running", currentCaseId: "answer-direct" },
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
    "running:answer-direct",
    "completed:--",
  ]);
});

test("waitForCliRunCompletion treats finalizing as non-terminal", async () => {
  const updates = [];
  const details = [
    { status: "running", currentCaseId: "answer-direct", completedCases: 0 },
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
    { status: "running", currentCaseId: "answer-direct", completedCases: 0 },
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
