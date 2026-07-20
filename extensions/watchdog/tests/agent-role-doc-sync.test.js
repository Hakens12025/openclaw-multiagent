import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// FIX(C9-doc-drift): 无守卫导致角色文档反复漂移 -> 以 AGENT_ROLE 为真值锁死文档
import { AGENT_ROLE, SUPPORTED_AGENT_ROLES } from "../lib/agent/agent-metadata.js";

const OPENCLAW_ROOT = fileURLToPath(new URL("../../..", import.meta.url));

async function readOpenClawFile(...parts) {
  return readFile(join(OPENCLAW_ROOT, ...parts), "utf8");
}

test("SYSTEM_MAP role table lists exactly the six real AGENT_ROLE values", async () => {
  const systemMap = await readOpenClawFile("SYSTEM_MAP.md");
  const start = systemMap.indexOf("## 3. Agent 角色");
  const section = systemMap.slice(start, systemMap.indexOf("## 4.", start));
  assert.ok(start >= 0 && section.length > 0, "SYSTEM_MAP must keep a '## 3. Agent 角色' section");

  for (const role of SUPPORTED_AGENT_ROLES) {
    assert.match(section, new RegExp(`\\*\\*${role}\\*\\*`), `role table missing real role ${role}`);
  }
  assert.doesNotMatch(section, /\*\*evaluator\*\*/, "evaluator is not a role");
  assert.doesNotMatch(section, /\*\*contractor\*\*/, "contractor is an agent-id, not a role");
  assert.equal(SUPPORTED_AGENT_ROLES.size, 6);
  assert.equal(Object.keys(AGENT_ROLE).length, 6);
});

test("README prose describes roles without the phantom evaluator role", async () => {
  const readme = await readOpenClawFile("README.md");
  assert.match(readme, /executor/);
  assert.doesNotMatch(readme, /excutor/, "typo 'excutor' must become 'executor'");
  assert.doesNotMatch(readme, /evaluator 评估/, "README must not call evaluator a runtime role");
});

test("benchmark.js is marked legacy and points to test-runner single entry", async () => {
  const benchmark = await readOpenClawFile("benchmark.js");
  const header = benchmark.slice(0, benchmark.indexOf("*/"));
  assert.match(header, /DEPRECATED|LEGACY/i);
  assert.match(header, /test-runner\.js/);
});

test("ssh-tunnel.sh header reconciles with start.sh tunnel strategy", async () => {
  const tunnel = await readOpenClawFile("ssh-tunnel.sh");
  const header = tunnel.slice(0, 800);
  assert.match(header, /LEGACY/i);
  assert.match(header, /start\.sh/);
});
