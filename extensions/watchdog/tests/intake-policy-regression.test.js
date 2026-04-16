import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { registerRuntimeAgents } from "../lib/agent/agent-identity.js";
import { handleBeforeStartIngress } from "../lib/ingress/before-start-ingress.js";
import { agentWorkspace, runtimeAgentConfigs } from "../lib/state.js";

const logger = { info() {}, warn() {}, error() {} };

function cleanup() {
  runtimeAgentConfigs.clear();
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
      enqueue() {},
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

test("handleBeforeStartIngress creates contract for agent without noDirectIntake policy", async () => {
  const tmpDir = join(tmpdir(), `intake-test-allow-${Date.now()}`);
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
      enqueue() {},
      wakeContractor() {},
      logger,
    });

    let contractCreated = false;
    try {
      await readFile(join(inboxDir, "contract.json"), "utf8");
      contractCreated = true;
    } catch {}

    assert.equal(contractCreated, true,
      "normal agent should get a contract.json from direct intake");
  } finally {
    cleanup();
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});
