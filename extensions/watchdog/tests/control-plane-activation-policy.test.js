import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { canAutoWakeForTaskRuntime } from "../lib/agent/agent-activation-policy.js";
import { runtimeAgentConfigs } from "../lib/state.js";
import { hasActionableHeartbeatWork } from "../lib/heartbeat-gate.js";
import { dispatchSendDirectRequest } from "../lib/routing/dispatch/dispatch-transport.js";
import { runtimeWakeAgentDetailed } from "../lib/transport/runtime-wake-transport.js";

const logger = { info() {}, warn() {}, error() {} };

test.afterEach(() => {
  runtimeAgentConfigs.clear();
});

test("ordinary task runtime cannot auto-wake operator", () => {
  assert.equal(
    canAutoWakeForTaskRuntime({
      agentId: "operator",
      plane: "control_plane",
      autoWakeEligible: false,
    }),
    false,
  );
});

test("passive heartbeat is not actionable for hidden control-plane operator", async () => {
  const actionable = await hasActionableHeartbeatWork("operator", {
    sessionKey: "agent:operator:main",
    agentId: "operator",
    status: "running",
    contract: null,
  }, "agent:operator:main");

  assert.equal(actionable, false);
});

test("ordinary task runtime cannot queue direct request into operator inbox", async () => {
  const inboxDir = join(tmpdir(), `openclaw-operator-activation-${Date.now()}`, "inbox");
  await mkdir(inboxDir, { recursive: true });

  try {
    const result = await dispatchSendDirectRequest({
      targetAgent: "operator",
      inboxDir,
      contract: {
        id: `TC-OP-${Date.now()}`,
        task: "should not enter operator runtime",
      },
      from: "system",
      logger,
    });

    assert.equal(result.ok, false);
    assert.equal(result.blocked, true);
    assert.match(result.blockReason || "", /operator/);
    assert.deepEqual(await readdir(inboxDir), []);
  } finally {
    await rm(join(inboxDir, ".."), { recursive: true, force: true });
  }
});

test("ordinary task runtime cannot queue direct request into an unregistered agent inbox", async () => {
  const inboxDir = join(tmpdir(), `openclaw-ghost-activation-${Date.now()}`, "inbox");
  await mkdir(inboxDir, { recursive: true });

  try {
    const result = await dispatchSendDirectRequest({
      targetAgent: "ghost-agent",
      inboxDir,
      contract: {
        id: `TC-GHOST-${Date.now()}`,
        task: "should not enter unknown runtime",
      },
      from: "system",
      logger,
    });

    assert.equal(result.ok, false);
    assert.equal(result.blocked, true);
    assert.match(result.blockReason || result.wake?.error || "", /ghost-agent|unregistered|runtime/i);
    assert.deepEqual(await readdir(inboxDir), []);
  } finally {
    await rm(join(inboxDir, ".."), { recursive: true, force: true });
  }
});

test("ordinary task runtime cannot auto-wake an unregistered agent", async () => {
  let heartbeatCalls = 0;
  const result = await runtimeWakeAgentDetailed("ghost-agent", "wake ghost", {
    runtime: {
      system: {
        requestHeartbeatNow() {
          heartbeatCalls += 1;
        },
      },
    },
  }, logger);

  assert.equal(result.ok, false);
  assert.equal(result.requested, false);
  assert.equal(result.reason, "control_plane_activation_blocked");
  assert.equal(heartbeatCalls, 0);
});
