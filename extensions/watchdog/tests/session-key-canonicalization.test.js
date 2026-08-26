import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildAgentContractSessionKey,
  buildAgentMainSessionKey,
  parseAgentContractSessionKey,
} from "../lib/session/session-keys.js";

const WATCHDOG_ROOT = fileURLToPath(new URL("..", import.meta.url));

test("session key helpers build canonical main and contract session keys", () => {
  assert.equal(buildAgentMainSessionKey("worker-a"), "agent:worker-a:main");
  assert.equal(buildAgentContractSessionKey("worker-a", "TC-123"), "agent:worker-a:contract:TC-123");
  assert.equal(buildAgentMainSessionKey("  "), null);
  assert.equal(buildAgentContractSessionKey("worker-a", ""), null);
  assert.deepEqual(
    parseAgentContractSessionKey("agent:worker-a:contract:TC-123"),
    { agentId: "worker-a", contractId: "TC-123" },
  );
  assert.equal(parseAgentContractSessionKey("agent:worker-a:main"), null);
});

test("core runtime files use canonical session key helpers instead of hand-written templates", async () => {
  const files = [
    join(WATCHDOG_ROOT, "lib", "agent", "agent-identity.js"),
    join(WATCHDOG_ROOT, "lib", "automation", "automation-round-context.js"),
    join(WATCHDOG_ROOT, "lib", "automation", "automation-registry.js"),
    join(WATCHDOG_ROOT, "lib", "ingress", "before-start-ingress.js"),
    join(WATCHDOG_ROOT, "lib", "routing", "delivery", "delivery-terminal.js"),
    join(WATCHDOG_ROOT, "lib", "routing", "dispatch", "dispatch-graph-policy.js"),
    join(WATCHDOG_ROOT, "lib", "routing", "delivery", "delivery-system-action-helpers.js"),
    join(WATCHDOG_ROOT, "lib", "schedule", "schedule-registry.js"),
    join(WATCHDOG_ROOT, "lib", "schedule", "schedule-trigger.js"),
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
  const filePath = join(WATCHDOG_ROOT, "lib", "loop", "loop-engine.js");
  await assert.rejects(readFile(filePath, "utf8"), { code: "ENOENT" });
});
