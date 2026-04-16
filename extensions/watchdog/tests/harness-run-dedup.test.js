import test from "node:test";
import assert from "node:assert/strict";
import { unlink } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

import { recordHarnessRun, getHarnessRun } from "../lib/harness/harness-run-store.js";

const HARNESS_RUNS_DIR = join(homedir(), ".openclaw", "research-lab", "harness-runs");
function runPath(runId) {
  return join(HARNESS_RUNS_DIR, `${runId}.json`);
}

test("syntheticAutomationId 'agent_end:workerX' passes normalizeHarnessSpec validation", async () => {
  const run = await recordHarnessRun({
    id: `harness:dedup-synthetic:${Date.now()}`,
    automationId: "agent_end:worker-alpha",
    round: 1,
    trigger: "agent_end_terminal",
    enabled: true,
    executionMode: "freeform",
    assuranceLevel: "low_assurance",
    agentId: "worker-alpha",
    contractId: "TC-DEDUP-SYNTH",
    sessionKey: "agent:worker-alpha:dedup-session",
    status: "completed",
    terminalStatus: "completed",
    executor: { kind: "agent", agentId: "worker-alpha" },
    toolUsage: { totalCalls: 5 },
    artifacts: [],
    diagnostics: { traceId: "trace-dedup", warnings: [], error: null },
    outcome: { result: "completed", retryable: false, summary: "" },
  });

  try {
    assert.ok(run.id);
    assert.equal(run.automationId, "agent_end:worker-alpha");
    const persisted = await getHarnessRun(run.id);
    assert.equal(persisted?.automationId, "agent_end:worker-alpha");
  } finally {
    await unlink(runPath(run.id)).catch(() => {});
  }
});

test("syntheticAutomationId 'loop_session:xxx' passes validation", async () => {
  const run = await recordHarnessRun({
    id: `harness:dedup-loop:${Date.now()}`,
    automationId: "loop_session:ls-1234",
    round: 2,
    trigger: "agent_end_terminal",
    enabled: true,
    executionMode: "freeform",
    agentId: "worker-beta",
    contractId: "TC-DEDUP-LOOP",
    sessionKey: "agent:worker-beta:dedup-loop",
    status: "completed",
    executor: { kind: "agent", agentId: "worker-beta" },
    toolUsage: { totalCalls: 3 },
    diagnostics: { traceId: "trace-loop", warnings: [], error: null },
  });

  try {
    assert.ok(run.id);
    assert.equal(run.automationId, "loop_session:ls-1234");
    assert.equal(run.round, 2);
  } finally {
    await unlink(runPath(run.id)).catch(() => {});
  }
});

test("loop_detected warning persisted in diagnostics.warnings", async () => {
  const run = await recordHarnessRun({
    id: `harness:dedup-loopwarn:${Date.now()}`,
    automationId: "agent_end:worker-loop",
    round: 1,
    trigger: "agent_end_terminal",
    enabled: true,
    executionMode: "freeform",
    agentId: "worker-loop",
    contractId: "TC-DEDUP-LOOPWARN",
    sessionKey: "agent:worker-loop:session",
    status: "completed",
    completionReason: "loop_detected",
    summary: "session terminated due to repeated tool calls",
    executor: { kind: "agent", agentId: "worker-loop" },
    toolUsage: { totalCalls: 10 },
    diagnostics: {
      traceId: "trace-loop-warn",
      warnings: ["loop_detected"],
      error: null,
    },
  });

  try {
    assert.ok(run.id);
    assert.ok(run.diagnostics?.warnings?.includes("loop_detected"));
    assert.equal(run.completionReason, "loop_detected");
    assert.equal(run.summary, "session terminated due to repeated tool calls");

    const persisted = await getHarnessRun(run.id);
    assert.ok(persisted?.diagnostics?.warnings?.includes("loop_detected"));
    assert.equal(persisted?.completionReason, "loop_detected");
  } finally {
    await unlink(runPath(run.id)).catch(() => {});
  }
});
