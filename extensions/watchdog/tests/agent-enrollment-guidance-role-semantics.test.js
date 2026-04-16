import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { buildConfiguredCandidate } from "../lib/agent/agent-enrollment-discovery.js";
import { syncAgentWorkspaceGuidance, buildAgentCard } from "../lib/workspace-guidance-writer.js";

test("buildConfiguredCandidate treats executor guidance as SOUL plus HEARTBEAT only", async () => {
  const agentId = `worker-guidance-${Date.now()}`;
  const workspaceDir = await mkdtemp(join(tmpdir(), "openclaw-executor-guidance-"));

  try {
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

    const candidate = await buildConfiguredCandidate({
      id: agentId,
      binding: {
        roleRef: "executor",
        workspace: { configured: workspaceDir },
        model: { ref: "demo/model" },
      },
    }, { agents: { list: [] } });

    assert.equal(candidate?.status, "managed");
    assert.deepEqual(
      candidate?.guidanceFiles?.map((entry) => entry.name),
      ["SOUL.md", "HEARTBEAT.md"],
    );
    assert.deepEqual(candidate?.guidance, {
      managed: 2,
      custom: 0,
      missing: 0,
    });
    assert.deepEqual(candidate?.plannedActions, []);
    assert.deepEqual(candidate?.attentionReasons, []);
    assert.deepEqual(candidate?.missingRequirements, []);
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});
