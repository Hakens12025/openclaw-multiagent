import test from "node:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";

import { agentWorkspace } from "../lib/state.js";
import { readAgentCard, syncAgentWorkspaceProfile, writeAgentCardProfile } from "../lib/agent/agent-admin-profile.js";

test("writeAgentCardProfile preserves sibling changes under concurrent writes", async () => {
  const agentId = `agent-profile-race-${Date.now()}`;
  const workspaceDir = agentWorkspace(agentId);

  try {
    await Promise.all([
      writeAgentCardProfile(agentId, {
        role: "executor",
        effectiveSkills: ["skill.alpha"],
        name: "Alpha Name",
      }),
      writeAgentCardProfile(agentId, {
        role: "executor",
        effectiveSkills: ["skill.alpha"],
        description: "Beta Description",
      }),
    ]);

    const card = await readAgentCard(agentId);
    assert.equal(card?.name, "Alpha Name");
    assert.equal(card?.description, "Beta Description");
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("syncAgentWorkspaceProfile preserves sibling changes under concurrent writes", async () => {
  const agentId = `agent-sync-race-${Date.now()}`;
  const workspaceDir = agentWorkspace(agentId);

  try {
    await Promise.all([
      syncAgentWorkspaceProfile(agentId, {
        role: "planner",
        effectiveSkills: ["skill.plan"],
        name: "Planner Name",
      }),
      syncAgentWorkspaceProfile(agentId, {
        role: "planner",
        effectiveSkills: ["skill.plan"],
        description: "Planner Description",
      }),
    ]);

    const card = await readAgentCard(agentId);
    assert.equal(card?.name, "Planner Name");
    assert.equal(card?.description, "Planner Description");
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});
