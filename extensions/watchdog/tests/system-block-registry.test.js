import test from "node:test";
import assert from "node:assert/strict";

import {
  SYSTEM_BLOCKS,
  buildSystemBlockReport,
  classifySystemBlockPath,
  getSystemBlock,
  summarizeSystemBlockDiff,
} from "../lib/dev/system-block-registry.js";

const EXPECTED_BLOCKS = [
  "runtime-core",
  "io-delivery",
  "agent-assembly",
  "local-execution",
  "graph-dispatch-queue",
  "loop-stage",
  "harness-assurance",
  "operator-cli-control",
  "automation-governance",
  "projection-ui",
  "verification-docs",
];

test("system block registry exposes the approved formal board", () => {
  assert.deepEqual(SYSTEM_BLOCKS.map((block) => block.id), EXPECTED_BLOCKS);
  assert.equal(SYSTEM_BLOCKS.every((block) => block.ownedTruth.length > 0), true);
  assert.equal(SYSTEM_BLOCKS.every((block) => block.interfaces.length > 0), true);
  assert.equal(SYSTEM_BLOCKS.every((block) => block.minimalTests.length > 0), true);
});

test("getSystemBlock returns the agent-facing contract for a block", () => {
  assert.deepEqual(
    getSystemBlock("graph-dispatch-queue").ownedTruth,
    ["graph edge authorization", "conveyor dispatch", "runtime queue", "worker pool claim/release"],
  );
  assert.equal(getSystemBlock("missing"), null);
});

test("classifySystemBlockPath maps current files to formal blocks", () => {
  assert.equal(classifySystemBlockPath("extensions/watchdog/lib/contract-store.js"), "runtime-core");
  assert.equal(classifySystemBlockPath("extensions/watchdog/routes/a2a.js"), "io-delivery");
  assert.equal(classifySystemBlockPath("extensions/watchdog/lib/agent-binding-store.js"), "agent-assembly");
  assert.equal(classifySystemBlockPath("extensions/watchdog/hooks/before-agent-start.js"), "local-execution");
  assert.equal(classifySystemBlockPath("extensions/watchdog/lib/agent-graph.js"), "graph-dispatch-queue");
  assert.equal(classifySystemBlockPath("extensions/watchdog/lib/loop-session-store.js"), "loop-stage");
  assert.equal(classifySystemBlockPath("extensions/watchdog/lib/harness-module-runner.js"), "harness-assurance");
  assert.equal(classifySystemBlockPath("extensions/watchdog/lib/operator-snapshot.js"), "operator-cli-control");
  assert.equal(classifySystemBlockPath("extensions/watchdog/lib/automation-executor.js"), "automation-governance");
  assert.equal(classifySystemBlockPath("extensions/watchdog/dashboard-contract-lane.js"), "projection-ui");
  assert.equal(classifySystemBlockPath("extensions/watchdog/lib/dev/system-block-registry.js"), "verification-docs");
  assert.equal(classifySystemBlockPath("scripts/openclaw-block-check.js"), "verification-docs");
  assert.equal(classifySystemBlockPath("AGENTS.md"), "verification-docs");
  assert.equal(classifySystemBlockPath("CLAUDE.md"), "verification-docs");
  assert.equal(classifySystemBlockPath("CODEX.md"), "verification-docs");
  assert.equal(classifySystemBlockPath("extensions/watchdog/tests/conveyor.test.js"), "verification-docs");
});

test("summarizeSystemBlockDiff allows verification docs as support without hiding cross-block runtime drift", () => {
  const summary = summarizeSystemBlockDiff({
    primaryBlock: "graph-dispatch-queue",
    files: [
      "extensions/watchdog/lib/dispatch.js",
      "extensions/watchdog/tests/dispatch-graph-policy.test.js",
      "extensions/watchdog/dashboard-contract-lane.js",
      "scratch/random-note.txt",
    ],
  });

  assert.equal(summary.primaryBlock, "graph-dispatch-queue");
  assert.deepEqual(summary.byBlock["graph-dispatch-queue"], ["extensions/watchdog/lib/dispatch.js"]);
  assert.deepEqual(summary.byBlock["verification-docs"], ["extensions/watchdog/tests/dispatch-graph-policy.test.js"]);
  assert.deepEqual(summary.byBlock["projection-ui"], ["extensions/watchdog/dashboard-contract-lane.js"]);
  assert.deepEqual(summary.unclassified, ["scratch/random-note.txt"]);
  assert.deepEqual(summary.crossBlockRuntimeFiles, ["extensions/watchdog/dashboard-contract-lane.js"]);
});

test("buildSystemBlockReport reports excessive cross-block edits", () => {
  const report = buildSystemBlockReport({
    primaryBlock: "graph-dispatch-queue",
    files: [
      "extensions/watchdog/lib/dispatch.js",
      "extensions/watchdog/lib/contract-store.js",
      "extensions/watchdog/lib/automation-executor.js",
      "extensions/watchdog/lib/harness-module-runner.js",
      "extensions/watchdog/tests/dispatch-graph-policy.test.js",
    ],
  });

  assert.equal(report.ok, false);
  assert.deepEqual(report.problems, [
    "cross-block runtime edit for graph-dispatch-queue: extensions/watchdog/lib/contract-store.js",
    "cross-block runtime edit for graph-dispatch-queue: extensions/watchdog/lib/automation-executor.js",
    "cross-block runtime edit for graph-dispatch-queue: extensions/watchdog/lib/harness-module-runner.js",
    "edits touch 4 non-support blocks; split this task before implementation",
  ]);
});
