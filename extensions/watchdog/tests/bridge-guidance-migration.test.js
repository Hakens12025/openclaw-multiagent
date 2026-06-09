import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AGENT_ROLE } from "../lib/agent/agent-identity.js";
import { renderRolePersonaBlock } from "../lib/role-spec-registry.js";
import { MANAGED_BOOTSTRAP_MARKER } from "../lib/managed-doc-markers.js";
import { syncAgentWorkspaceGuidance } from "../lib/workspace-guidance-writer.js";
import {
  backupWorkspaceGuidanceFiles,
  GUIDANCE_BACKUP_RETENTION,
} from "../lib/agent/agent-guidance-backup.js";

// 六层模型: ④role(bridge persona) 改由 renderRolePersonaBlock 渲染并写进 IDENTITY.md(系统托管)。
// ⑤SOUL 改用户拥有(无 marker, 平台永不重写)。

test("bridge role persona renders distinct from the default-agent persona", () => {
  const bridge = renderRolePersonaBlock(AGENT_ROLE.BRIDGE);
  const fallback = renderRolePersonaBlock(AGENT_ROLE.AGENT);
  assert.match(bridge, /Bridge node/, "bridge persona mentions bridge semantics");
  assert.notEqual(bridge, fallback, "bridge persona differs from the generic agent persona");
});

test("managed bridge IDENTITY carries the role persona + bootstrap marker", () => {
  const persona = renderRolePersonaBlock(AGENT_ROLE.BRIDGE);
  assert.match(persona, /^## Role/);
  // The persona block itself is marker-free; the IDENTITY writer prepends the marker.
  assert.doesNotMatch(persona, new RegExp(MANAGED_BOOTSTRAP_MARKER.replace(/[-:/]/g, "\\$&")));
});

test("bridge sync writes managed IDENTITY (persona) and leaves a user-owned SOUL untouched", async () => {
  const workspaceDir = await mkdtemp(join(tmpdir(), "bridge-migrate-"));
  try {
    // Seed a persona-polluted bridge SOUL (no managed marker) — user-owned, must survive.
    const userSoul = "# controller\n\n你是系统的总指挥官。自己决定什么任务该派给谁。\n";
    await writeFile(join(workspaceDir, "SOUL.md"), userSoul, "utf8");
    // Seed the framework default IDENTITY scaffold — must be replaced by the managed persona.
    await writeFile(join(workspaceDir, "IDENTITY.md"), "# IDENTITY.md - Who Am I?\n", "utf8");

    const updated = await syncAgentWorkspaceGuidance({
      agentId: "controller",
      role: AGENT_ROLE.BRIDGE,
      skills: [],
      workspaceDir,
      graph: { edges: [] },
      loops: [],
    });

    const identityStatus = updated.find((entry) => entry.name === "IDENTITY.md");
    assert.equal(identityStatus?.updated, true, "default IDENTITY scaffold upgraded to managed persona");
    const identity = await readFile(join(workspaceDir, "IDENTITY.md"), "utf8");
    assert.ok(identity.includes(MANAGED_BOOTSTRAP_MARKER), "managed IDENTITY carries the bootstrap marker");
    assert.match(identity, /## Role/, "managed IDENTITY carries the role persona block");
    assert.match(identity, /Bridge node/, "managed IDENTITY carries the bridge persona");

    // SOUL is user-owned: sync must not rewrite it, and it must not be in the returned manifest.
    const soulAfter = await readFile(join(workspaceDir, "SOUL.md"), "utf8");
    assert.equal(soulAfter, userSoul, "user-owned SOUL survives sync verbatim");
    assert.equal(updated.find((entry) => entry.name === "SOUL.md"), undefined, "SOUL not part of managed manifest");
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("takeover backup snapshots a custom IDENTITY before the managed persona overwrites it", async () => {
  const workspaceDir = await mkdtemp(join(tmpdir(), "bridge-migrate-backup-"));
  try {
    const customIdentity = "# controller\n\n用户自定义身份正文。\n";
    await writeFile(join(workspaceDir, "IDENTITY.md"), customIdentity, "utf8");

    const backupBefore = await backupWorkspaceGuidanceFiles({
      workspaceDir,
      fileNames: ["IDENTITY.md"],
    });
    assert.ok(backupBefore.backupDir, "backup dir created");
    assert.equal(backupBefore.backupPaths.length, 1);
    const backupIdentity = await readFile(join(backupBefore.backupDir, "IDENTITY.md"), "utf8");
    assert.equal(backupIdentity, customIdentity);

    const updated = await syncAgentWorkspaceGuidance({
      agentId: "controller",
      role: AGENT_ROLE.BRIDGE,
      skills: [],
      workspaceDir,
      graph: { edges: [] },
      loops: [],
      overwriteCustomGuidance: true,
    });
    const identityStatus = updated.find((entry) => entry.name === "IDENTITY.md");
    assert.equal(identityStatus?.updated, true);
    const afterTakeover = await readFile(join(workspaceDir, "IDENTITY.md"), "utf8");
    assert.ok(afterTakeover.includes(MANAGED_BOOTSTRAP_MARKER));
    assert.match(afterTakeover, /## Role/);
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("backup retention policy is keep-last-10 per agent workspace", () => {
  assert.equal(GUIDANCE_BACKUP_RETENTION, 10);
});
