import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { syncAgentWorkspaceGuidance } from "../lib/workspace-guidance-writer.js";
import { AGENT_ROLE } from "../lib/agent/agent-metadata.js";
import { MANAGED_BOOTSTRAP_MARKER } from "../lib/prompt/managed-doc-markers.js";

// 六层模型重构: soul-template-builder.js 已整体删除(④role 改 renderRolePersonaBlock + IDENTITY 载体)。

test("soul-template-builder module is fully retired", async () => {
  await assert.rejects(
    () => import("../lib/soul-template-builder.js"),
    /Cannot find module|ERR_MODULE_NOT_FOUND/,
    "soul-template-builder.js 应已删除",
  );
});

test("startup sync never rewrites a user-owned SOUL (no-marker body survives)", async () => {
  const workspaceDir = await mkdtemp(join(tmpdir(), "legacy-retire-"));
  try {
    const userSoul = "# worker-x\n\n用户自定义人格正文。\n";
    await writeFile(join(workspaceDir, "SOUL.md"), userSoul, "utf8");
    const updates = await syncAgentWorkspaceGuidance({
      agentId: "worker-x",
      role: AGENT_ROLE.EXECUTOR,
      skills: [],
      workspaceDir,
      graph: { edges: [] },
      loops: [],
    });
    const stillThere = await readFile(join(workspaceDir, "SOUL.md"), "utf8");
    assert.equal(stillThere, userSoul, "user-owned SOUL must survive startup sync unchanged");
    assert.equal(updates.find((entry) => entry.name === "SOUL.md"), undefined, "SOUL is not part of managed sync");
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("startup sync writes/refreshes the managed IDENTITY persona for execution-layer agents", async () => {
  const workspaceDir = await mkdtemp(join(tmpdir(), "legacy-retire-identity-"));
  try {
    const updates = await syncAgentWorkspaceGuidance({
      agentId: "worker-x",
      role: AGENT_ROLE.EXECUTOR,
      skills: [],
      workspaceDir,
      graph: { edges: [] },
      loops: [],
    });
    const identityStatus = updates.find((entry) => entry.name === "IDENTITY.md");
    assert.equal(identityStatus?.updated, true, "managed IDENTITY is written on sync");
    const identity = await readFile(join(workspaceDir, "IDENTITY.md"), "utf8");
    assert.match(identity, new RegExp(MANAGED_BOOTSTRAP_MARKER.replace(/[-:/]/g, "\\$&")));
    assert.match(identity, /## Role/, "managed IDENTITY carries the role persona");
    // SOUL is not seeded by sync (only bootstrap seeds the placeholder); execution layer still keeps HEARTBEAT.
    await access(join(workspaceDir, "HEARTBEAT.md"));
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});
