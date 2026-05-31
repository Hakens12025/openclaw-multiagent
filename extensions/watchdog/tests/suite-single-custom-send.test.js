import test, { beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";

const sendViaBridgeCalls = [];
const sendTestInjectCalls = [];
const wakeAgentNowCalls = [];
const fetchJSONCalls = [];
let mockWorkItems = [
  {
    id: "TC-CUSTOM-SEND-1",
    status: "completed",
  },
];
let mockPostAdmin = async () => ({ ok: true });

mock.module("../lib/formal-runtime/infra.js", {
  namedExports: {
    PORT: 18789,
    OUTPUT_DIR: "/tmp/openclaw-output",
    fetchJSON: async (path) => {
      fetchJSONCalls.push(path);
      if (path === "/watchdog/work-items") {
        return mockWorkItems;
      }
      return [];
    },
    sendViaBridge: async (message) => {
      sendViaBridgeCalls.push(message);
      return { ok: true };
    },
    sendTestInject: async (message, source, replyTo) => {
      sendTestInjectCalls.push({ message, source, replyTo });
      return { ok: true };
    },
    wakeAgentNow: async (agentId, message) => {
      wakeAgentNowCalls.push({ agentId, message });
      return { ok: true };
    },
    postAdmin: async (path, payload) => mockPostAdmin(path, payload),
    sleep: async () => {},
  },
});

const { runSingleTest } = await import("../lib/formal-runtime/suite-single.js");
const {
  getContractPath,
  persistContractSnapshot,
  readContractSnapshotById,
} = await import("../lib/contracts.js");
const { CONTRACT_STATUS } = await import("../lib/core/runtime-status.js");
const { dispatchTargetStateMap } = await import("../lib/state.js");

beforeEach(() => {
  sendViaBridgeCalls.length = 0;
  sendTestInjectCalls.length = 0;
  wakeAgentNowCalls.length = 0;
  fetchJSONCalls.length = 0;
  mockWorkItems = [
    {
      id: "TC-CUSTOM-SEND-1",
      status: "completed",
    },
  ];
  mockPostAdmin = async () => ({ ok: true });
});

test("runSingleTest uses custom sendMessage instead of default bridge/direct sender", async () => {
  const customSendCalls = [];
  const sse = {
    events: [],
    waitFor: async () => ({
      type: "alert",
      data: {
        type: "inbox_dispatch",
        contractId: "TC-CUSTOM-SEND-1",
        task: "custom sender task",
      },
      receivedAt: Date.now(),
    }),
  };

  const result = await runSingleTest({
    id: "custom-send-1",
    message: "custom sender task",
  }, sse, undefined, 0, {
    sendMessageLabel: "custom sender",
    sendMessage: async (message) => {
      customSendCalls.push(message);
      return { ok: true };
    },
  });

  assert.equal(result.pass, true);
  assert.equal(result.contractId, "TC-CUSTOM-SEND-1");
  assert.deepEqual(customSendCalls, ["custom sender task"]);
  assert.deepEqual(sendViaBridgeCalls, []);
  assert.deepEqual(sendTestInjectCalls, []);
  assert.deepEqual(wakeAgentNowCalls, []);
  assert.deepEqual(fetchJSONCalls, ["/watchdog/work-items"]);
});

test("runSingleTest terminalizes the contract when the case timeout expires", async () => {
  const contractId = `TC-SINGLE-TIMEOUT-${Date.now()}`;
  const contractPath = getContractPath(contractId);

  await persistContractSnapshot(contractPath, {
    id: contractId,
    task: "timeout task",
    assignee: "worker",
    output: `/tmp/${contractId}.md`,
    status: CONTRACT_STATUS.RUNNING,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    protocol: {
      version: 1,
      envelope: "execution_contract",
      source: "webui",
    },
  });

  try {
    dispatchTargetStateMap.clear();
    dispatchTargetStateMap.set("worker", {
      busy: true,
      healthy: true,
      dispatching: false,
      lastSeen: Date.now(),
      currentContract: contractId,
      queue: [
        { contractId, fromAgent: "planner" },
        { contractId: "TC-OTHER-QUEUED", fromAgent: "planner" },
      ],
    });
    mockPostAdmin = async (path, payload) => {
      assert.equal(path, "/watchdog/tests/terminalize");
      assert.equal(payload.contractId, contractId);
      assert.equal(payload.status, CONTRACT_STATUS.FAILED);
      const persisted = await readContractSnapshotById(contractId);
      await persistContractSnapshot(contractPath, {
        ...persisted,
        status: CONTRACT_STATUS.FAILED,
        terminalOutcome: {
          version: 1,
          status: CONTRACT_STATUS.FAILED,
          source: payload.source,
          reason: payload.reason,
          summary: payload.summary,
          retryable: false,
        },
      });
      const state = dispatchTargetStateMap.get("worker");
      state.busy = false;
      state.dispatching = false;
      state.currentContract = null;
      state.queue = state.queue.filter((entry) => entry.contractId !== contractId);
      return { ok: true };
    };

    const sse = {
      events: [],
      waitFor: async () => ({
        type: "alert",
        data: {
          type: "inbox_dispatch",
          contractId,
          task: "timeout task",
        },
        receivedAt: 0,
      }),
    };

    const result = await runSingleTest({
      id: "timeout-case",
      message: "timeout task",
      timeoutMs: 0,
    }, sse);

    assert.equal(result.pass, false);
    assert.equal(result.errorCode, "E_TIMEOUT");

    const persisted = await readContractSnapshotById(contractId);
    assert.equal(persisted.status, CONTRACT_STATUS.FAILED);
    assert.equal(persisted.terminalOutcome?.status, CONTRACT_STATUS.FAILED);
    assert.equal(persisted.terminalOutcome?.source, "test_runner");
    assert.match(persisted.terminalOutcome?.reason || "", /case_timeout/u);
    assert.equal(result.contractRuntime?.status, CONTRACT_STATUS.FAILED);

    const dispatchState = dispatchTargetStateMap.get("worker");
    assert.equal(dispatchState?.busy, false);
    assert.equal(dispatchState?.dispatching, false);
    assert.equal(dispatchState?.currentContract, null);
    assert.deepEqual(dispatchState?.queue, [
      { contractId: "TC-OTHER-QUEUED", fromAgent: "planner" },
    ]);
  } finally {
    dispatchTargetStateMap.clear();
    await rm(contractPath, { force: true });
  }
});

test("runSingleTest fails QQ transport when final QQ completion delivery failed", async () => {
  const contractId = `TC-QQ-EGRESS-FAILED-${Date.now()}`;
  const contractPath = getContractPath(contractId);
  mockWorkItems = [
    {
      id: contractId,
      status: CONTRACT_STATUS.COMPLETED,
    },
  ];

  await persistContractSnapshot(contractPath, {
    id: contractId,
    task: "qq delivery failure task",
    assignee: "worker",
    output: `/tmp/${contractId}.md`,
    status: CONTRACT_STATUS.COMPLETED,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    protocol: {
      version: 1,
      envelope: "execution_contract",
      source: "qqbot",
    },
    runtimeDiagnostics: {
      terminalDelivery: {
        ok: false,
        channel: "qqbot",
        error: "rate_limited",
      },
    },
  });

  try {
    const sse = {
      events: [],
      waitFor: async () => ({
        type: "alert",
        data: {
          type: "inbox_dispatch",
          contractId,
          task: "qq delivery failure task",
        },
        receivedAt: Date.now(),
      }),
    };

    const result = await runSingleTest({
      id: "qq-egress-failed",
      message: "qq delivery failure task",
    }, sse, undefined, 0, {
      transport: "qq",
      source: "qqbot",
      replyTo: {
        channel: "qqbot",
        target: "c2c:test-user",
        accountId: "default",
      },
    });

    assert.equal(result.pass, false);
    assert.equal(result.errorCode, "E_QQ_DELIVERY_FAILED");
    assert.match(result.errorDetail, /rate_limited/u);
  } finally {
    await rm(contractPath, { force: true });
  }
});

test("runSingleTest fails QQ transport when only non-QQ fanout delivery succeeded", async () => {
  const contractId = `TC-QQ-FANOUT-ONLY-${Date.now()}`;
  const contractPath = getContractPath(contractId);
  mockWorkItems = [
    {
      id: contractId,
      status: CONTRACT_STATUS.COMPLETED,
    },
  ];

  await persistContractSnapshot(contractPath, {
    id: contractId,
    task: "qq fanout only task",
    assignee: "worker",
    output: `/tmp/${contractId}.md`,
    status: CONTRACT_STATUS.COMPLETED,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    protocol: {
      version: 1,
      envelope: "execution_contract",
      source: "qqbot",
    },
    runtimeDiagnostics: {
      terminalDelivery: {
        ok: true,
        channel: "delivery",
        notified: false,
        fanout: [
          {
            ok: true,
            channel: "webui",
            notified: true,
          },
        ],
      },
    },
  });

  try {
    const sse = {
      events: [],
      waitFor: async () => ({
        type: "alert",
        data: {
          type: "inbox_dispatch",
          contractId,
          task: "qq fanout only task",
        },
        receivedAt: Date.now(),
      }),
    };

    const result = await runSingleTest({
      id: "qq-fanout-only",
      message: "qq fanout only task",
    }, sse, undefined, 0, {
      transport: "qq",
      source: "qqbot",
      replyTo: {
        channel: "qqbot",
        target: "c2c:test-user",
        accountId: "default",
      },
    });

    assert.equal(result.pass, false);
    assert.equal(result.errorCode, "E_QQ_DELIVERY_FAILED");
    assert.match(result.errorDetail, /channel=delivery/u);
    assert.match(result.errorDetail, /notified=false/u);
  } finally {
    await rm(contractPath, { force: true });
  }
});
