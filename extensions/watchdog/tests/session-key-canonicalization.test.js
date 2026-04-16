import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  buildAgentContractSessionKey,
  buildAgentMainSessionKey,
  buildPipelineStageSessionKey,
  parseAgentContractSessionKey,
} from "../lib/session-keys.js";

test("session key helpers build canonical main and contract session keys", () => {
  assert.equal(buildAgentMainSessionKey("worker-a"), "agent:worker-a:main");
  assert.equal(buildAgentContractSessionKey("worker-a", "TC-123"), "agent:worker-a:contract:TC-123");
  assert.equal(
    buildPipelineStageSessionKey({
      targetAgent: "worker-a",
      pipelineId: "PL-1",
      loopSessionId: "LS-1",
      round: 2,
      stageName: "reviewer",
    }),
    "agent:worker-a:pipeline:PL-1:loop_session:LS-1:round:2:stage:reviewer",
  );
  assert.equal(
    buildPipelineStageSessionKey({
      targetAgent: "worker-a",
      pipelineId: "PL-1",
      round: 1,
      stageName: "planner",
    }),
    "agent:worker-a:pipeline:PL-1:round:1:stage:planner",
  );
  assert.equal(buildAgentMainSessionKey("  "), null);
  assert.equal(buildAgentContractSessionKey("worker-a", ""), null);
  assert.deepEqual(
    parseAgentContractSessionKey("agent:worker-a:contract:TC-123"),
    { agentId: "worker-a", contractId: "TC-123" },
  );
  assert.equal(parseAgentContractSessionKey("agent:worker-a:main"), null);
  assert.equal(buildPipelineStageSessionKey({ targetAgent: "worker-a", pipelineId: "", stageName: "planner" }), null);
});

test("core runtime files use canonical session key helpers instead of hand-written templates", async () => {
  const files = [
    join(process.cwd(), "lib", "agent", "agent-identity.js"),
    join(process.cwd(), "lib", "automation", "automation-harness-lifecycle.js"),
    join(process.cwd(), "lib", "automation", "automation-registry.js"),
    join(process.cwd(), "lib", "ingress", "before-start-ingress.js"),
    join(process.cwd(), "lib", "routing", "delivery-terminal.js"),
    join(process.cwd(), "lib", "routing", "dispatch-graph-policy.js"),
    join(process.cwd(), "lib", "routing", "delivery-system-action-helpers.js"),
    join(process.cwd(), "lib", "schedule", "schedule-registry.js"),
    join(process.cwd(), "lib", "schedule", "schedule-trigger.js"),
  ];

  for (const filePath of files) {
    const content = await readFile(filePath, "utf8");
    assert.match(content, /from "\.\.\/.*session-keys\.js"|from "\.\/.*session-keys\.js"/, `${filePath} should import canonical session key helpers`);
    assert.doesNotMatch(
      content,
      /`agent:\$\{[^`]+\}:main`|`agent:\$\{[^`]+\}:contract:\$\{[^`]+\}`/,
      `${filePath} still hand-writes agent session keys`,
    );
  }
});

test("deleted loop-engine does not linger as a private session-key builder", async () => {
  const filePath = join(process.cwd(), "lib", "loop", "loop-engine.js");
  await assert.rejects(readFile(filePath, "utf8"), { code: "ENOENT" });
});
