import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const ingressDispatchCalls = [];

mock.module("../lib/ingress/dispatch-entry.js", {
  namedExports: {
    dispatchAcceptIngressMessage: async (message, options = {}) => {
      ingressDispatchCalls.push({ message, options });
      return { ok: true, contractId: "TC-WEBUI-WRAPPED" };
    },
  },
});

const { registerRuntimeAgents } = await import("../lib/agent/agent-identity.js");
const { handleBeforeStartIngress } = await import("../lib/ingress/before-start-ingress.js");
const { runtimeAgentConfigs, sseClients } = await import("../lib/state.js");
const {
  WAKE_SEMANTIC_TYPE,
  buildRuntimeWakeEnvelope,
} = await import("../lib/transport/runtime-wake-envelope.js");

const logger = { info() {}, warn() {}, error() {} };

function cleanup() {
  runtimeAgentConfigs.clear();
}

function captureSseEvents() {
  const events = [];
  const client = {
    finished: false,
    destroyed: false,
    write(payload) {
      const eventMatch = String(payload).match(/^event:\s*(.+)$/m);
      const dataMatch = String(payload).match(/^data:\s*(.+)$/m);
      if (!eventMatch || !dataMatch) return;
      events.push({
        event: eventMatch[1],
        data: JSON.parse(dataMatch[1]),
      });
    },
  };
  sseClients.add(client);
  return {
    events,
    close() {
      sseClients.delete(client);
    },
  };
}

test("handleBeforeStartIngress skips direct intake for agent with noDirectIntake policy", async () => {
  const tmpDir = join(tmpdir(), `intake-test-${Date.now()}`);
  try {
    registerRuntimeAgents({
      agents: {
        list: [
          {
            id: "test-evaluator",
            binding: {
              roleRef: "evaluator",
              workspace: { configured: tmpDir },
              policies: {
                executionPolicy: { noDirectIntake: true },
              },
            },
          },
        ],
      },
    });

    const inboxDir = join(tmpDir, "inbox");
    await mkdir(inboxDir, { recursive: true });

    await handleBeforeStartIngress({
      event: { prompt: "hello evaluator, please review this" },
      agentId: "test-evaluator",
      sessionKey: "agent:test-evaluator:hook:test",
      api: { runtime: { system: { requestHeartbeatNow() {} } } },
      wakeContractor() {},
      logger,
    });

    let contractCreated = false;
    try {
      await readFile(join(inboxDir, "contract.json"), "utf8");
      contractCreated = true;
    } catch {}

    assert.equal(contractCreated, false,
      "noDirectIntake agent should NOT get a contract.json from direct intake");
  } finally {
    cleanup();
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("handleBeforeStartIngress ignores core wrapped hook content instead of treating it as WebUI ingress truth", async () => {
  ingressDispatchCalls.length = 0;
  try {
    registerRuntimeAgents({
      agents: {
        list: [
          {
            id: "controller",
            binding: {
              roleRef: "bridge",
              policies: {
                gateway: true,
                ingressSource: "webui",
              },
            },
          },
        ],
      },
    });

    await handleBeforeStartIngress({
      event: {
        prompt: [
          "Task: Hook | before_agent_start",
          "<<<EXTERNAL_UNTRUSTED_CONTENT>>>",
          "Source: webui",
          "---",
          "hello through topology",
          "<<<END_EXTERNAL_UNTRUSTED_CONTENT>>>",
        ].join("\n"),
      },
      agentId: "controller",
      sessionKey: "agent:controller:hook:webui",
      api: { runtime: { system: { requestHeartbeatNow() {} } } },
      logger,
    });

    assert.equal(ingressDispatchCalls.length, 0);
  } finally {
    cleanup();
  }
});

test("handleBeforeStartIngress blocks ordinary direct intake instead of creating a topology-free envelope", async () => {
  const tmpDir = join(tmpdir(), `intake-test-allow-${Date.now()}`);
  const sse = captureSseEvents();
  try {
    registerRuntimeAgents({
      agents: {
        list: [
          {
            id: "test-worker",
            binding: {
              roleRef: "executor",
              workspace: { configured: tmpDir },
            },
          },
        ],
      },
    });

    const inboxDir = join(tmpDir, "inbox");
    await mkdir(inboxDir, { recursive: true });

    await handleBeforeStartIngress({
      event: { prompt: "please implement this feature for me" },
      agentId: "test-worker",
      sessionKey: "agent:test-worker:hook:test",
      api: { runtime: { system: { requestHeartbeatNow() {} } } },
      wakeContractor() {},
      logger,
    });

    let contractCreated = false;
    try {
      await readFile(join(inboxDir, "contract.json"), "utf8");
      contractCreated = true;
    } catch {}

    assert.equal(contractCreated, false,
      "ordinary direct intake should not create a topology-free contract.json");
    assert.ok(
      sse.events.some((entry) => (
        entry.event === "alert"
        && entry.data?.type === "direct_intake_blocked"
        && entry.data?.agentId === "test-worker"
      )),
      "blocked direct intake should be observable as a runtime diagnostic",
    );
  } finally {
    sse.close();
    cleanup();
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("handleBeforeStartIngress blocks direct intake without touching an occupied shared inbox", async () => {
  const tmpDir = join(tmpdir(), `intake-test-occupied-${Date.now()}`);
  try {
    registerRuntimeAgents({
      agents: {
        list: [
          {
            id: "test-worker-occupied",
            binding: {
              roleRef: "executor",
              workspace: { configured: tmpDir },
            },
          },
        ],
      },
    });

    const inboxDir = join(tmpDir, "inbox");
    await mkdir(inboxDir, { recursive: true });
    await writeFile(join(inboxDir, "contract.json"), JSON.stringify({
      id: "TC-SHARED-ACTIVE",
      protocol: {
        version: 1,
        envelope: "execution_contract",
      },
      task: "active shared contract must be preserved",
    }, null, 2), "utf8");

    await handleBeforeStartIngress({
      event: { prompt: "please handle this direct user message later" },
      agentId: "test-worker-occupied",
      sessionKey: "agent:test-worker-occupied:hook:test",
      api: { runtime: { system: { requestHeartbeatNow() {} } } },
      logger,
    });

    const activeInbox = JSON.parse(await readFile(join(inboxDir, "contract.json"), "utf8"));
    assert.equal(activeInbox.id, "TC-SHARED-ACTIVE");
    await assert.rejects(
      readdir(join(inboxDir, ".runtime-direct-envelope-queue")),
      /ENOENT/,
    );
  } finally {
    cleanup();
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("handleBeforeStartIngress ignores typed internal wake envelopes instead of wrapping them as direct intake", async () => {
  const tmpDir = join(tmpdir(), `intake-test-internal-${Date.now()}`);
  try {
    registerRuntimeAgents({
      agents: {
        list: [
          {
            id: "test-reviewer",
            binding: {
              roleRef: "reviewer",
              workspace: { configured: tmpDir },
            },
          },
        ],
      },
    });

    const inboxDir = join(tmpDir, "inbox");
    await mkdir(inboxDir, { recursive: true });

    for (const wakeEnvelope of [
      buildRuntimeWakeEnvelope({
        semanticType: WAKE_SEMANTIC_TYPE.SYSTEM_ACTION_WAKE_AGENT,
        targetAgentId: "test-reviewer",
        sourceAgentId: "worker-a",
        actionType: "wake_agent",
      }),
      buildRuntimeWakeEnvelope({
        semanticType: WAKE_SEMANTIC_TYPE.REQUEST_REVIEW_DISPATCH,
        targetAgentId: "test-reviewer",
        sourceAgentId: "worker-a",
        deliveryTicketId: "DT-review-1",
      }),
      buildRuntimeWakeEnvelope({
        semanticType: WAKE_SEMANTIC_TYPE.TERMINAL_DELIVERY_READY,
        targetAgentId: "test-reviewer",
        deliveryId: "DL-123",
        contractId: "TC-123",
      }),
      buildRuntimeWakeEnvelope({
        semanticType: WAKE_SEMANTIC_TYPE.SYSTEM_ACTION_DELIVERY_RESUME,
        targetAgentId: "test-reviewer",
        deliveryTicketId: "DT-delivery-1",
      }),
    ]) {
      await rm(join(inboxDir, "contract.json"), { force: true }).catch(() => {});
      await handleBeforeStartIngress({
        event: { prompt: wakeEnvelope.renderText, wakeEnvelope },
        agentId: "test-reviewer",
        sessionKey: "agent:test-reviewer:hook:test",
        api: { runtime: { system: { requestHeartbeatNow() {} } } },
        logger,
      });

      await assert.rejects(
        readFile(join(inboxDir, "contract.json"), "utf8"),
        /ENOENT/,
      );
    }
  } finally {
    cleanup();
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});
