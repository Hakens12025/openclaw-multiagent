import test, { beforeEach, mock } from "node:test";
import assert from "node:assert/strict";

const sendViaBridgeCalls = [];
const wakeAgentNowCalls = [];
const fetchJSONCalls = [];

mock.module("./infra.js", {
  namedExports: {
    PORT: 18789,
    OUTPUT_DIR: "/tmp/openclaw-output",
    fetchJSON: async (path) => {
      fetchJSONCalls.push(path);
      if (path === "/watchdog/work-items") {
        return [
          {
            id: "TC-CUSTOM-SEND-1",
            status: "completed",
          },
        ];
      }
      return [];
    },
    sendViaBridge: async (message) => {
      sendViaBridgeCalls.push(message);
      return { ok: true };
    },
    wakeAgentNow: async (agentId, message) => {
      wakeAgentNowCalls.push({ agentId, message });
      return { ok: true };
    },
    sleep: async () => {},
  },
});

const { runSingleTest } = await import("./suite-single.js");

beforeEach(() => {
  sendViaBridgeCalls.length = 0;
  wakeAgentNowCalls.length = 0;
  fetchJSONCalls.length = 0;
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
  assert.deepEqual(wakeAgentNowCalls, []);
  assert.deepEqual(fetchJSONCalls, ["/watchdog/work-items"]);
});
