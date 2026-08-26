import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { CONTRACT_STATUS } from "../lib/core/runtime-status.js";
import { markSessionHardStopped, HARD_STOP_REASON, clearAllSessions } from "../lib/runtime/execution-hard-stop-registry.js";

const commits = [];
const finalizedSessions = [];

mock.module("../lib/routing/terminal-commit.js", {
  namedExports: {
    commitSemanticTerminalState: async ({
      trackingState,
      terminalStatus,
      terminalOutcome,
      extraFields = {},
    }) => {
      commits.push({ trackingState, terminalStatus, terminalOutcome, extraFields });
      trackingState.status = terminalStatus;
      trackingState.contract.status = terminalStatus;
      trackingState.contract.terminalOutcome = terminalOutcome;
      return { committed: true };
    },
  },
});

mock.module("../lib/lifecycle/runtime-lifecycle.js", {
  namedExports: {
    finalizeAgentSession: async ({ agentId, sessionKey }) => {
      finalizedSessions.push({ agentId, sessionKey });
    },
  },
});

mock.module("../lib/routing/dispatch/dispatch-graph-policy.js", {
  namedExports: {
    resolveRouteAfterAgentEndTarget: async () => ({
      routable: false,
      action: "terminal",
      target: null,
    }),
  },
});

const { terminalizeHardStoppedRuntimeSession } = await import("../lib/runtime/hard-stop-terminalize.js");

test.afterEach(() => {
  commits.length = 0;
  finalizedSessions.length = 0;
  clearAllSessions();
});

test("hard stop does not complete from default contract.output evidence", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "openclaw-hard-stop-"));
  const outputPath = join(tempDir, "answer.md");
  const sessionKey = `agent:worker:hard-stop:${Date.now()}`;
  const agentId = "worker";
  const trackingState = {
    sessionKey,
    agentId,
    status: CONTRACT_STATUS.RUNNING,
    contract: {
      id: `TC-HARD-STOP-${Date.now()}`,
      task: "answer hello",
      assignee: agentId,
      output: outputPath,
      status: CONTRACT_STATUS.RUNNING,
    },
  };

  try {
    await writeFile(outputPath, "hello\n", "utf8");
    markSessionHardStopped(sessionKey, HARD_STOP_REASON.REPEAT_THRESHOLD);

    const result = await terminalizeHardStoppedRuntimeSession({
      agentId,
      sessionKey,
      trackingState,
      api: {},
      logger: { info() {}, warn() {}, error() {} },
    });

    assert.equal(result.terminalized, true);
    assert.equal(commits.length, 1);
    assert.equal(commits[0].terminalStatus, CONTRACT_STATUS.FAILED);
    assert.equal(commits[0].terminalOutcome.status, CONTRACT_STATUS.FAILED);
    // 字面量而非引 HARD_STOP_TERMINAL_SOURCE:该字段无枚举校验,引常量会让改名悄悄通过。
    assert.equal(commits[0].terminalOutcome.source, "execution_hard_stop");
    assert.equal(finalizedSessions.length, 1);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
