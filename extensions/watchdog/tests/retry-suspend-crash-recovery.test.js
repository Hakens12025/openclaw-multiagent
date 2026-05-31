import { test, mock } from "node:test";
import assert from "node:assert/strict";

const qqTypingStopCalls = [];
const wakeCalls = [];
const writtenFiles = [];

mock.module("../lib/state.js", {
  namedExports: {
    cfg: {
      qqAppId: "",
      qqClientSecret: "",
    },
    agentWorkspace: (agentId) => `/tmp/${agentId}`,
    atomicWriteFile: async (path, content) => {
      writtenFiles.push({ path, content });
    },
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

mock.module("../lib/channel-notify.js", {
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
  writtenFiles.length = 0;

  const originalSetTimeout = globalThis.setTimeout;
  const timerPromises = [];
  globalThis.setTimeout = ((callback, _delay, ...args) => {
    timerPromises.push(Promise.resolve(callback(...args)));
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
    await Promise.all(timerPromises);

    assert.equal(result.status, "retry_scheduled");
    assert.equal(trackingState.status, TRACKING_STATUS.WAITING_RETRY);
    assert.deepEqual(qqTypingStopCalls, ["TC-RETRY"]);
    assert.equal(wakeCalls.length, 1);
    assert.match(wakeCalls[0][1], /Retry scheduled/i);
    assert.match(wakeCalls[0][1], /inbox\/retry-hint\.md/);
    assert.doesNotMatch(wakeCalls[0][1], /simulated crash/);
    assert.equal(writtenFiles.length, 1);
    assert.match(writtenFiles[0].path, /retry-hint\.md$/);
    assert.match(writtenFiles[0].content, /Next retry/);
    assert.doesNotMatch(writtenFiles[0].content, /避免|请/u);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
});
