import test from "node:test";
import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";

import { OC, agentWorkspace, runtimeAgentConfigs } from "../lib/state.js";
import { createAgentDefinition } from "../lib/agent/agent-admin-agent-operations.js";
import { loadConfig, saveConfig } from "../lib/agent/agent-admin-store.js";
import { composeDefaultCapabilityProjection } from "../lib/agent/agent-capability-policy.js";
import { executeAdminSurfaceOperation } from "../lib/admin/admin-surface-operations.js";
import { runGlobalTestEnvironmentSerial } from "../lib/formal-runtime/test-locks.js";

const logger = {
  info() {},
  warn() {},
  error() {},
};

test("agents.tools writes runtime truth and keeps card/runtime/operator views aligned", { concurrency: false }, async () => {
  await runGlobalTestEnvironmentSerial(async () => {
    const agentId = `tools-truth-${Date.now()}`;
    const originalConfigRaw = await readFile(join(OC, "openclaw.json"), "utf8");

    try {
      await createAgentDefinition({
        id: agentId,
        role: "executor",
        model: "ollama/qwen3.5:0.8b",
        logger,
      });

      const narrowed = await executeAdminSurfaceOperation({
        surfaceId: "agents.tools",
        payload: {
          agentId,
          tools: ["read"],
        },
        logger,
      });

      assert.equal(narrowed?.ok, true);
      assert.deepEqual(narrowed?.configuredTools, ["read"]);
      assert.deepEqual(narrowed?.effectiveTools, ["read"]);

      const narrowedConfig = await loadConfig();
      const narrowedAgent = narrowedConfig.agents.list.find((entry) => entry?.id === agentId);
      const narrowedCard = JSON.parse(await readFile(join(agentWorkspace(agentId), "agent-card.json"), "utf8"));

      assert.deepEqual(
        narrowedAgent?.tools?.allow,
        ["read"],
        "formal tools surface should write configured tools into top-level runtime truth",
      );
      assert.equal(
        Object.prototype.hasOwnProperty.call(narrowedAgent?.binding?.capabilities?.configured || {}, "tools"),
        false,
        "stored binding residue should not keep a second tools truth",
      );
      assert.deepEqual(
        narrowedCard?.capabilities?.tools,
        ["read"],
        "agent-card projection should mirror the runtime tools truth instead of drifting independently",
      );
      assert.deepEqual(
        runtimeAgentConfigs.get(agentId)?.capabilities?.tools,
        ["read"],
        "runtime registry should expose the same tools truth to operator and automation consumers",
      );

      const expectedDefaultTools = composeDefaultCapabilityProjection({
        role: "executor",
      }).tools;

      const cleared = await executeAdminSurfaceOperation({
        surfaceId: "agents.tools",
        payload: {
          agentId,
          tools: ["default"],
        },
        logger,
      });

      assert.equal(cleared?.ok, true);
      assert.equal(cleared?.configuredTools, null);
      assert.deepEqual(cleared?.effectiveTools, expectedDefaultTools);

      const clearedConfig = await loadConfig();
      const clearedAgent = clearedConfig.agents.list.find((entry) => entry?.id === agentId);
      const clearedCard = JSON.parse(await readFile(join(agentWorkspace(agentId), "agent-card.json"), "utf8"));

      assert.deepEqual(
        clearedAgent?.tools?.allow,
        expectedDefaultTools,
        "clearing the override should still persist default tools into the formal top-level runtime truth",
      );
      assert.deepEqual(
        clearedCard?.capabilities?.tools,
        expectedDefaultTools,
        "card projection should mirror the same effective default tools after clearing the override",
      );
      assert.deepEqual(
        runtimeAgentConfigs.get(agentId)?.capabilities?.tools,
        expectedDefaultTools,
        "runtime registry should expose the same effective default tools after clearing the override",
      );
      assert.equal(
        Object.prototype.hasOwnProperty.call(clearedAgent?.binding?.capabilities?.configured || {}, "tools"),
        false,
        "binding residue should still avoid storing a second tools truth after clearing the override",
      );
    } finally {
      await saveConfig(JSON.parse(originalConfigRaw));
      await rm(agentWorkspace(agentId), { recursive: true, force: true });
    }
  });
});
