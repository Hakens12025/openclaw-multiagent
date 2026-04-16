import test from "node:test";
import assert from "node:assert/strict";
import { unlink } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

import {
  getHarnessRun,
  listHarnessRunsByContract,
  recordHarnessRun,
} from "../lib/harness/harness-run-store.js";

const HARNESS_RUNS_DIR = join(homedir(), ".openclaw", "research-lab", "harness-runs");

function runPath(runId) {
  return join(HARNESS_RUNS_DIR, `${runId}.json`);
}

test("recordHarnessRun preserves canonical rich HarnessRun fields", async () => {
  const run = await recordHarnessRun({
    id: `harness:test-rich:${Date.now()}`,
    automationId: `automation-rich-${Date.now()}`,
    round: 2,
    requestedAt: Date.now() - 1000,
    enabled: true,
    executionMode: "guarded",
    profileId: "experiment.research_cycle",
    profileTrustLevel: "stable",
    moduleRefs: ["harness:collector.artifact", "harness:gate.artifact"],
    coverage: {
      hardShaped: ["artifact", "trace"],
      softGuided: ["evaluation"],
      freeform: [],
    },
    status: "completed",
    startedAt: Date.now() - 500,
    finalizedAt: Date.now(),
    contractId: "TC-HARNESS-RICH",
    pipelineId: "pipe-rich",
    loopId: "loop-rich",
    decision: "continue",
    runtimeStatus: "idle",
    score: 0.42,
    artifact: "/tmp/harness-rich.md",
    summary: "rich harness run preserved",
    moduleRuns: [
      {
        moduleId: "harness:collector.artifact",
        kind: "collector",
        status: "passed",
        summary: "artifact captured",
      },
      {
        moduleId: "harness:gate.artifact",
        kind: "gate",
        status: "passed",
        summary: "artifact present",
      },
    ],
    executor: {
      kind: "agent",
      agentId: "worker-rich",
    },
    sessionKey: "agent:worker-rich:harness",
    toolUsage: {
      totalCalls: 3,
      byTool: {
        read: 1,
        write: 2,
      },
    },
    artifacts: [
      {
        kind: "stage_artifact",
        path: "/tmp/harness-rich.md",
      },
    ],
    diagnostics: {
      traceId: "trace-rich",
      warnings: ["late_artifact"],
      error: null,
    },
  });

  try {
    assert.equal(run.id.includes("harness:test-rich:"), true);
    assert.equal(run.profileId, "experiment.research_cycle");
    assert.equal(run.moduleCounts.passed, 2);
    assert.equal(run.gateSummary.verdict, "passed");
    assert.equal(run.toolUsage.totalCalls, 3);
    assert.equal(run.executor.agentId, "worker-rich");

    const persisted = await getHarnessRun(run.id);
    assert.equal(persisted?.id, run.id);
    assert.equal(persisted?.decision, "continue");
    assert.equal(persisted?.gateSummary?.verdict, "passed");
    assert.equal(persisted?.toolUsage?.byTool?.write, 2);
    assert.equal(persisted?.artifacts?.[0]?.path, "/tmp/harness-rich.md");
  } finally {
    await unlink(runPath(run.id)).catch(() => {});
  }
});

test("recordHarnessRun rejects legacy observed params that do not meet canonical HarnessRun requirements", async () => {
  await assert.rejects(
    () => recordHarnessRun({
      agentId: "worker-legacy",
      contractId: "TC-HARNESS-LEGACY",
      sessionKey: "agent:worker-legacy:session",
      status: "completed",
      toolUsage: {
        totalCalls: 5,
        byTool: {
          read: 2,
          write: 3,
        },
      },
      artifacts: [
        {
          kind: "stage_artifact",
          path: "/tmp/harness-legacy.md",
        },
      ],
      diagnostics: {
        traceId: "trace-legacy",
        warnings: ["execution_trace_off_track"],
        error: null,
      },
      outcome: {
        result: "completed",
        retryable: false,
        summary: "legacy run normalized",
      },
    }),
    /invalid harness run/,
  );
});

test("recordHarnessRun rejects legacy adapter module kinds", async () => {
  await assert.rejects(
    () => recordHarnessRun({
      id: `harness:test-normalizer:${Date.now()}`,
      automationId: `automation-normalizer-${Date.now()}`,
      round: 1,
      requestedAt: Date.now() - 500,
      enabled: true,
      executionMode: "hybrid",
      profileId: "experiment.research_cycle",
      moduleRuns: [
        {
          moduleId: "harness:normalizer.failure",
          kind: "adapter",
          status: "passed",
        },
      ],
      status: "completed",
      finalizedAt: Date.now(),
    }),
    /invalid harness run/,
  );
});
