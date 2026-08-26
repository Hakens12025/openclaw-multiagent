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
  "stage",
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
  assert.equal(classifySystemBlockPath("extensions/watchdog/lib/store/contract-store.js"), "runtime-core");
  assert.equal(classifySystemBlockPath("extensions/watchdog/routes/a2a.js"), "io-delivery");
  assert.equal(classifySystemBlockPath("extensions/watchdog/lib/agent/agent-binding-store.js"), "agent-assembly");
  assert.equal(classifySystemBlockPath("extensions/watchdog/hooks/before-agent-start.js"), "local-execution");
  assert.equal(classifySystemBlockPath("extensions/watchdog/lib/agent/agent-graph.js"), "graph-dispatch-queue");
  assert.equal(classifySystemBlockPath("extensions/watchdog/lib/stage/stage-projection.js"), "stage");
  assert.equal(classifySystemBlockPath("extensions/watchdog/lib/operator/operator-snapshot.js"), "operator-cli-control");
  assert.equal(classifySystemBlockPath("extensions/watchdog/lib/automation/automation-executor.js"), "automation-governance");
  assert.equal(classifySystemBlockPath("extensions/watchdog/ui/components/work-item-list.js"), "projection-ui");
  assert.equal(classifySystemBlockPath("extensions/watchdog/lib/dev/system-block-registry.js"), "verification-docs");
  assert.equal(classifySystemBlockPath("scripts/openclaw-block-check.js"), "verification-docs");
  assert.equal(classifySystemBlockPath("AGENTS.md"), "verification-docs");
  assert.equal(classifySystemBlockPath("CLAUDE.md"), "verification-docs");
  assert.equal(classifySystemBlockPath("CODEX.md"), "verification-docs");
  assert.equal(classifySystemBlockPath("extensions/watchdog/tests/conveyor.test.js"), "verification-docs");
});

test("classifySystemBlockPath honours first-match-wins exceptions inside shared directories", () => {
  // lib/session/ is runtime-core except the one bootstrap file owned by agent-assembly.
  assert.equal(classifySystemBlockPath("extensions/watchdog/lib/session/session-keys.js"), "runtime-core");
  assert.equal(classifySystemBlockPath("extensions/watchdog/lib/session/session-bootstrap.js"), "agent-assembly");
  // lib/security/ is local-execution except the two assembly-time registries.
  assert.equal(classifySystemBlockPath("extensions/watchdog/lib/security/security.js"), "local-execution");
  assert.equal(classifySystemBlockPath("extensions/watchdog/lib/security/capability-preset-registry.js"), "agent-assembly");
  assert.equal(classifySystemBlockPath("extensions/watchdog/lib/security/execution-policy-defaults.js"), "agent-assembly");
  // lib/stage/ is stage except the two observation files owned by local-execution.
  assert.equal(classifySystemBlockPath("extensions/watchdog/lib/stage/task-stage-plan.js"), "stage");
  assert.equal(classifySystemBlockPath("extensions/watchdog/lib/stage/io-observation.js"), "local-execution");
  assert.equal(classifySystemBlockPath("extensions/watchdog/lib/stage/execution-observation.js"), "local-execution");
  // Graph edge authorization stays with graph-dispatch-queue even though the files live under lib/agent/.
  assert.equal(classifySystemBlockPath("extensions/watchdog/lib/agent/agent-graph-mutations.js"), "graph-dispatch-queue");
  assert.equal(classifySystemBlockPath("extensions/watchdog/lib/agent/agent-identity.js"), "agent-assembly");
  // Failure classification folds back into local-execution (harness-assurance 块已随
  // harness 全退役删除，v226 / 2026-08-23；runtime-fault-evaluator 回到 lib/runtime/ 的宿主块)。
  assert.equal(classifySystemBlockPath("extensions/watchdog/lib/runtime/runtime-fault-evaluator.js"), "local-execution");
  assert.equal(classifySystemBlockPath("extensions/watchdog/lib/runtime/hard-stop-terminalize.js"), "local-execution");
});

test("summarizeSystemBlockDiff allows verification docs as support without hiding cross-block runtime drift", () => {
  const summary = summarizeSystemBlockDiff({
    primaryBlock: "graph-dispatch-queue",
    files: [
      "extensions/watchdog/lib/routing/dispatch/dispatch-graph-policy.js",
      "extensions/watchdog/tests/dispatch-graph-policy.test.js",
      "extensions/watchdog/ui/components/work-item-list.js",
      "scratch/random-note.txt",
    ],
  });

  assert.equal(summary.primaryBlock, "graph-dispatch-queue");
  assert.deepEqual(summary.byBlock["graph-dispatch-queue"], ["extensions/watchdog/lib/routing/dispatch/dispatch-graph-policy.js"]);
  assert.deepEqual(summary.byBlock["verification-docs"], ["extensions/watchdog/tests/dispatch-graph-policy.test.js"]);
  assert.deepEqual(summary.byBlock["projection-ui"], ["extensions/watchdog/ui/components/work-item-list.js"]);
  assert.deepEqual(summary.unclassified, ["scratch/random-note.txt"]);
  assert.deepEqual(summary.crossBlockRuntimeFiles, ["extensions/watchdog/ui/components/work-item-list.js"]);
});

test("buildSystemBlockReport reports excessive cross-block edits", () => {
  const report = buildSystemBlockReport({
    primaryBlock: "graph-dispatch-queue",
    files: [
      "extensions/watchdog/lib/routing/dispatch/dispatch-graph-policy.js",
      "extensions/watchdog/lib/store/contract-store.js",
      "extensions/watchdog/lib/automation/automation-executor.js",
      "extensions/watchdog/tests/dispatch-graph-policy.test.js",
    ],
  });

  assert.equal(report.ok, false);
  assert.deepEqual(report.problems, [
    "cross-block runtime edit for graph-dispatch-queue: extensions/watchdog/lib/store/contract-store.js",
    "cross-block runtime edit for graph-dispatch-queue: extensions/watchdog/lib/automation/automation-executor.js",
    "edits touch 3 non-support blocks; split this task before implementation",
  ]);
});
