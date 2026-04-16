import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  LOCAL_WORKSPACE_SOURCE,
  summarizeLocalAgentDiscovery,
} from "../lib/agent/agent-enrollment-discovery.js";
import { OC } from "../lib/state.js";
import { buildAgentCard, syncAgentWorkspaceGuidance } from "../lib/workspace-guidance-writer.js";

test("default discovery keeps local workspace residue out of roster and exposes it only through explicit local scope", async () => {
  const agentId = `discovery-residue-scope-${Date.now()}`;
  const workspaceDir = join(OC, "workspaces", agentId);

  try {
    await mkdir(workspaceDir, { recursive: true });
    await syncAgentWorkspaceGuidance({
      agentId,
      role: "executor",
      skills: [],
      workspaceDir,
      graph: { edges: [] },
      loops: [],
    });
    await writeFile(
      join(workspaceDir, "agent-card.json"),
      JSON.stringify(buildAgentCard({ agentId, role: "executor", skills: [] }), null, 2),
      "utf8",
    );

    const defaultDiscovery = await summarizeLocalAgentDiscovery();
    assert.equal(defaultDiscovery.agents.some((entry) => entry.id === agentId), false);
    assert.equal(defaultDiscovery.candidates.some((entry) => entry.id === agentId), false);

    const explicitLocalDiscovery = await summarizeLocalAgentDiscovery({ includeLocalWorkspace: true });
    assert.equal(explicitLocalDiscovery.agents.some((entry) => entry.id === agentId), false);
    assert.equal(explicitLocalDiscovery.candidates.some((entry) => entry.id === agentId), false);

    const residue = explicitLocalDiscovery.localWorkspaceResidue?.find((entry) => entry.id === agentId) || null;
    assert.equal(residue?.source, LOCAL_WORKSPACE_SOURCE);
    assert.ok(Array.isArray(explicitLocalDiscovery.localWorkspaceResidue));
    assert.ok(explicitLocalDiscovery.localWorkspaceResidue.some((entry) => entry.id === agentId));
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});
