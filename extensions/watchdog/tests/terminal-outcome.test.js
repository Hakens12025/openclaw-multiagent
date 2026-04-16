import test from "node:test";
import assert from "node:assert/strict";
import { readFile, unlink } from "node:fs/promises";

import {
  normalizeTerminalOutcome,
  resolveTerminalOutcome,
} from "../lib/terminal-outcome.js";
import { handleCrashRecovery } from "../lib/lifecycle/crash-recovery.js";
import { runAgentEndPipeline } from "../lib/lifecycle/agent-end-pipeline.js";
import { getContractPath, persistContractSnapshot } from "../lib/contracts.js";
import { CONTRACT_STATUS, TRACKING_STATUS } from "../lib/core/runtime-status.js";
import { createTrackingState } from "../lib/session-bootstrap.js";
import {
  clearTrackingStore,
  getTrackingState,
  getTerminalTrackingSessionReason,
  rememberTrackingState,
} from "../lib/store/tracker-store.js";
import { taskHistory } from "../lib/state.js";

const logger = {
  info() {},
  warn() {},
  error() {},
};

test("normalizeTerminalOutcome preserves terminal evidence fields", () => {
  const terminalOutcome = normalizeTerminalOutcome({
    status: CONTRACT_STATUS.COMPLETED,
    source: "stage_result",
    reason: "stage completed",
    summary: "rich terminal summary",
    verdict: "pass",
    score: 0.82,
    testsPassed: true,
    artifact: {
      path: "/tmp/terminal-outcome-rich.md",
      label: "output",
    },
  }, {
    terminalStatus: CONTRACT_STATUS.COMPLETED,
    ts: 123,
  });

  assert.equal(terminalOutcome.status, CONTRACT_STATUS.COMPLETED);
  assert.equal(terminalOutcome.source, "stage_result");
  assert.equal(terminalOutcome.reason, "stage completed");
  assert.equal(terminalOutcome.summary, "rich terminal summary");
  assert.equal(terminalOutcome.verdict, "pass");
  assert.equal(terminalOutcome.score, 0.82);
  assert.equal(terminalOutcome.testsPassed, true);
  assert.deepEqual(terminalOutcome.artifact, {
    path: "/tmp/terminal-outcome-rich.md",
    label: "output",
  });
});

test("resolveTerminalOutcome carries reviewer verdict evidence from executionObservation", async () => {
  const resolved = await resolveTerminalOutcome({
    trackingState: {
      contract: {
        id: "TC-TERMINAL-REVIEW-EVIDENCE",
        task: "review evidence contract",
        status: CONTRACT_STATUS.RUNNING,
      },
    },
    contractData: {
      id: "TC-TERMINAL-REVIEW-EVIDENCE",
      task: "review evidence contract",
      status: CONTRACT_STATUS.RUNNING,
    },
    executionObservation: {
      collected: true,
      contractId: "TC-TERMINAL-REVIEW-EVIDENCE",
      reviewerResult: {
        source: "system_action_review_delivery",
        verdict: "fail",
        score: 35,
        continueHint: "rework",
      },
      reviewVerdict: {
        verdict: "reject",
        score: 35,
      },
      stageRunResult: {
        status: "completed",
        summary: "review verdict captured",
        feedback: "reviewer rejected current implementation",
        primaryArtifactPath: "/tmp/review-verdict.json",
        artifacts: [
          {
            path: "/tmp/review-verdict.json",
            type: "evaluation_verdict",
            label: "review verdict",
            primary: true,
          },
        ],
        completion: {
          status: "completed",
          feedback: "reviewer rejected current implementation",
          transition: {
            kind: "hold",
            reason: "evaluation_rework",
          },
        },
      },
      stageCompletion: {
        status: "completed",
        feedback: "reviewer rejected current implementation",
        transition: {
          kind: "hold",
          reason: "evaluation_rework",
        },
      },
    },
    logger,
  });

  assert.equal(resolved.terminalStatus, CONTRACT_STATUS.COMPLETED);
  assert.equal(resolved.terminalOutcome.status, CONTRACT_STATUS.COMPLETED);
  assert.equal(resolved.terminalOutcome.source, "stage_result");
  assert.equal(resolved.terminalOutcome.reason, "reviewer rejected current implementation");
  assert.equal(resolved.terminalOutcome.summary, "review verdict captured");
  assert.equal(resolved.terminalOutcome.verdict, "fail");
  assert.equal(resolved.terminalOutcome.score, 35);
  assert.equal(resolved.terminalOutcome.testsPassed, false);
});

test("handleCrashRecovery persists terminalOutcome when retries are exhausted into abandoned", async () => {
  const contractId = `TC-TERMINAL-ABANDONED-${Date.now()}`;
  const contractPath = getContractPath(contractId);

  await persistContractSnapshot(contractPath, {
    id: contractId,
    task: "abandon after retry exhaustion",
    status: CONTRACT_STATUS.RUNNING,
    assignee: "contractor",
    retryCount: 2,
    phases: [],
    total: 1,
    output: `/tmp/${contractId}.md`,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    protocol: {
      version: 1,
      envelope: "execution_contract",
    },
  }, logger);

  try {
    const result = await handleCrashRecovery({
      agentId: "contractor",
      sessionKey: `agent:contractor:retry-exhausted:${Date.now()}`,
      trackingState: {
        contract: {
          id: contractId,
          path: contractPath,
          task: "abandon after retry exhaustion",
          status: CONTRACT_STATUS.RUNNING,
        },
        toolCalls: [],
      },
      error: "simulated exhausted crash",
      api: {},
      logger,
      maxRetryCount: 2,
      retryDelays: [1],
    });

    const persisted = JSON.parse(await readFile(contractPath, "utf8"));
    assert.equal(result.status, CONTRACT_STATUS.ABANDONED);
    assert.equal(persisted.status, CONTRACT_STATUS.ABANDONED);
    assert.equal(persisted.terminalOutcome?.status, CONTRACT_STATUS.ABANDONED);
    assert.equal(persisted.terminalOutcome?.reason, "simulated exhausted crash");
    assert.equal(persisted.terminalOutcome?.source, "runtime_crash");
  } finally {
    await unlink(contractPath).catch(() => {});
  }
});

test("handleCrashRecovery carries contract read diagnostics into retry-scheduled runtime truth", async () => {
  const contractId = `TC-TERMINAL-RETRY-DIAG-${Date.now()}`;
  const contractPath = getContractPath(contractId);

  await persistContractSnapshot(contractPath, {
    id: contractId,
    task: "retry crash keeps read diagnostics",
    status: CONTRACT_STATUS.RUNNING,
    assignee: "contractor",
    retryCount: 0,
    phases: [],
    total: 1,
    output: `/tmp/${contractId}.md`,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    protocol: {
      version: 1,
      envelope: "execution_contract",
    },
  }, logger);

  const trackingState = {
    sessionKey: `agent:contractor:retry-diagnostic:${Date.now()}`,
    status: CONTRACT_STATUS.RUNNING,
    startMs: Date.now() - 1000,
    toolCalls: [],
    toolCallTotal: 0,
    lastLabel: "运行中",
    contract: {
      id: contractId,
      path: contractPath,
      task: "retry crash keeps read diagnostics",
      status: CONTRACT_STATUS.RUNNING,
      total: 1,
      output: `/tmp/${contractId}.md`,
    },
  };

  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = ((callback, _delay, ...args) => {
    callback(...args);
    return 0;
  });

  try {
    await handleCrashRecovery({
      agentId: "contractor",
      sessionKey: trackingState.sessionKey,
      trackingState,
      error: "simulated retry crash with read failure",
      contractReadDiagnostic: {
        lane: "contract_read",
        contractPath,
        error: "snapshot missing",
        recoveredFromTrackingState: true,
        ts: 123,
      },
      api: {},
      logger,
      maxRetryCount: 3,
      retryDelays: [1],
    });

    const persisted = JSON.parse(await readFile(contractPath, "utf8"));
    assert.equal(trackingState.status, TRACKING_STATUS.WAITING_RETRY);
    assert.equal(persisted.status, CONTRACT_STATUS.RUNNING);
    assert.equal(persisted.runtimeDiagnostics?.contractRead?.error, "snapshot missing");
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    await unlink(contractPath).catch(() => {});
  }
});

test("runAgentEndPipeline retry crash suspends session without terminalizing tracking history", async () => {
  const contractId = `TC-TERMINAL-RETRY-ACTIVE-${Date.now()}`;
  const contractPath = getContractPath(contractId);
  const sessionKey = `agent:contractor:retry-active:${Date.now()}`;
  const originalHistoryLength = taskHistory.length;
  const wakeCalls = [];

  await persistContractSnapshot(contractPath, {
    id: contractId,
    task: "retry crash keeps contract active",
    status: CONTRACT_STATUS.RUNNING,
    assignee: "contractor",
    retryCount: 0,
    phases: [],
    total: 1,
    output: `/tmp/${contractId}.md`,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    protocol: {
      version: 1,
      envelope: "execution_contract",
    },
  }, logger);

  const trackingState = createTrackingState({
    sessionKey,
    agentId: "contractor",
    parentSession: null,
  });
  trackingState.contract = {
    id: contractId,
    path: contractPath,
    task: "retry crash keeps contract active",
    status: CONTRACT_STATUS.RUNNING,
    assignee: "contractor",
    total: 1,
    output: `/tmp/${contractId}.md`,
  };

  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = ((callback, _delay, ...args) => {
    callback(...args);
    return 0;
  });

  try {
    clearTrackingStore();
    taskHistory.length = 0;
    rememberTrackingState(sessionKey, trackingState);

    await runAgentEndPipeline({
      event: {
        success: false,
        error: "simulated retry crash",
      },
      ctx: {
        sessionKey,
        agentId: "contractor",
      },
      api: {
        runtime: {
          system: {
            requestHeartbeatNow(payload) {
              wakeCalls.push(payload);
            },
          },
        },
      },
      logger,
      enqueueFn: () => {},
      wakePlanner: async () => null,
      trackingState,
    });

    const persisted = JSON.parse(await readFile(contractPath, "utf8"));
    assert.equal(persisted.status, CONTRACT_STATUS.RUNNING);
    assert.equal(persisted.retryCount, 1);
    assert.equal(persisted.terminalOutcome, null);
    assert.equal(getTrackingState(sessionKey)?.sessionKey, sessionKey);
    assert.equal(getTerminalTrackingSessionReason(sessionKey), null);
    assert.equal(taskHistory.some((entry) => entry.sessionKey === sessionKey), false);
    assert.equal(wakeCalls.length, 1);
    assert.equal(wakeCalls[0]?.sessionKey, sessionKey);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    clearTrackingStore();
    taskHistory.length = originalHistoryLength;
    await unlink(contractPath).catch(() => {});
  }
});
