import { test, mock } from "node:test";
import assert from "node:assert/strict";

const qqTypingStopCalls = [];
const wakeCalls = [];

mock.module("../lib/state.js", {
  namedExports: {
    agentWorkspace: (agentId) => `/tmp/${agentId}`,
    atomicWriteFile: async () => {},
    CONTRACTS_DIR: "/tmp/contracts",
    isWorker: () => true,
  },
});

mock.module("../lib/transport/sse.js", {
  namedExports: {
    broadcast: () => {},
  },
});

mock.module("../lib/core/event-types.js", {
  namedExports: {
    EVENT_TYPE: {
      ERROR: "error",
    },
  },
});

mock.module("../lib/contracts.js", {
  namedExports: {
    readContractSnapshotByPath: async () => ({
      id: "TC-RETRY",
      task: "retry me",
      status: "running",
      retryCount: 0,
    }),
    updateContractStatus: async () => ({ ok: true }),
    mutateContractSnapshot: async () => ({ result: null }),
    evaluateContractOutcome: async () => ({
      status: "failed",
      reason: "simulated crash",
    }),
  },
});

mock.module("../lib/qq.js", {
  namedExports: {
    qqNotify: () => {},
    qqTypingStop: (contractId) => {
      qqTypingStopCalls.push(contractId);
    },
    getQQTarget: () => null,
  },
});

mock.module("../lib/error-ledger.js", {
  namedExports: {
    recordErrorPattern: async () => {},
  },
});

mock.module("../lib/transport/runtime-wake-transport.js", {
  namedExports: {
    runtimeWakeAgentDetailed: async (...args) => {
      wakeCalls.push(args);
    },
  },
});

const { handleCrashRecovery } = await import("../lib/lifecycle/crash-recovery.js");
const { TRACKING_STATUS, CONTRACT_STATUS } = await import("../lib/core/runtime-status.js");

const logger = { info() {}, warn() {}, error() {} };

test("retry-scheduled worker crash keeps reservation and only stops typing", async () => {
  qqTypingStopCalls.length = 0;
  wakeCalls.length = 0;

  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = ((callback, _delay, ...args) => {
    callback(...args);
    return 0;
  });

  try {
    const trackingState = {
      sessionKey: "agent:worker-a:contract:TC-RETRY",
      status: CONTRACT_STATUS.RUNNING,
      toolCalls: [],
      lastLabel: "运行中",
      contract: {
        id: "TC-RETRY",
        path: "/tmp/TC-RETRY.json",
        task: "retry me",
        status: CONTRACT_STATUS.RUNNING,
      },
    };

    const result = await handleCrashRecovery({
      agentId: "worker-a",
      sessionKey: trackingState.sessionKey,
      trackingState,
      error: "simulated crash",
      api: {},
      logger,
      maxRetryCount: 3,
      retryDelays: [1],
    });

    assert.equal(result.status, "retry_scheduled");
    assert.equal(trackingState.status, TRACKING_STATUS.WAITING_RETRY);
    assert.deepEqual(qqTypingStopCalls, ["TC-RETRY"]);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
});
