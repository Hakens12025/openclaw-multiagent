import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AGENT_ROLE } from "../lib/agent/agent-identity.js";
import {
  buildBridgeSoulTemplate,
  buildSoulTemplate,
  MANAGED_BOOTSTRAP_MARKER,
} from "../lib/soul-template-builder.js";
import { syncAgentWorkspaceGuidance } from "../lib/workspace-guidance-writer.js";
import {
  backupWorkspaceGuidanceFiles,
  GUIDANCE_BACKUP_RETENTION,
} from "../lib/agent/agent-guidance-backup.js";

test("bridge SOUL template keeps minimal formal dispatch entrypoint", () => {
  const soul = buildBridgeSoulTemplate("bridge-migrate", AGENT_ROLE.BRIDGE);
  assert.match(soul, /\[ACTION\] delegate/);
  assert.doesNotMatch(soul, /```[\s\S]*\[ACTION\] delegate/);
  assert.doesNotMatch(soul, /\[DISPATCH\]/);
  assert.ok(soul.startsWith(MANAGED_BOOTSTRAP_MARKER));
});

test("buildSoulTemplate dispatches to bridge branch for BRIDGE role", () => {
  const bridge = buildSoulTemplate("bridge-dispatcher", AGENT_ROLE.BRIDGE);
  const fallback = buildSoulTemplate("bridge-dispatcher", "agent");
  assert.match(bridge, /Bridge Local Handling Principles/);
  assert.doesNotMatch(fallback, /Bridge Local Handling Principles/);
});

test("bridge workspace takeover writes managed bridge SOUL into .guidance-backup-protected location", async () => {
  const workspaceDir = await mkdtemp(join(tmpdir(), "bridge-migrate-"));
  try {
    // Seed a persona-polluted bridge SOUL (no managed marker).
    const legacyBridge = "# controller\n\n你是系统的总指挥官。自己决定什么任务该派给谁。\n";
    await writeFile(join(workspaceDir, "SOUL.md"), legacyBridge, "utf8");

    // Pre-takeover backup (simulating the takeover-pre snapshot).
    const backupBefore = await backupWorkspaceGuidanceFiles({
      workspaceDir,
      fileNames: ["SOUL.md"],
    });
    assert.ok(backupBefore.backupDir, "backup dir created");
    assert.equal(backupBefore.backupPaths.length, 1);
    const backupSoul = await readFile(join(backupBefore.backupDir, "SOUL.md"), "utf8");
    assert.equal(backupSoul, legacyBridge);

    // Force-sync managed bridge SOUL.
    const updated = await syncAgentWorkspaceGuidance({
      agentId: "controller",
      role: AGENT_ROLE.BRIDGE,
      skills: [],
      workspaceDir,
      graph: { edges: [] },
      loops: [],
      overwriteCustomGuidance: true,
    });
    const soulStatus = updated.find((entry) => entry.name === "SOUL.md");
    assert.equal(soulStatus?.updated, true);
    const afterTakeover = await readFile(join(workspaceDir, "SOUL.md"), "utf8");
    assert.match(afterTakeover, /\[ACTION\] delegate/);
    assert.doesNotMatch(afterTakeover, /```[\s\S]*\[ACTION\] delegate/);
    assert.ok(afterTakeover.includes(MANAGED_BOOTSTRAP_MARKER));
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("backup retention policy is keep-last-10 per agent workspace", () => {
  assert.equal(GUIDANCE_BACKUP_RETENTION, 10);
});
