import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  summarizeLocalAgentDiscovery,
} from "../lib/agent/agent-enrollment-discovery.js";
import {
  readLocalAgentGuidancePreview,
  writeLocalAgentGuidanceContent,
} from "../lib/agent/agent-enrollment-guidance.js";
import { OC } from "../lib/state.js";
import { buildAgentCard, syncAgentWorkspaceGuidance } from "../lib/workspace-guidance-writer.js";

const logger = {
  info() {},
  warn() {},
  error() {},
};

test("execution-layer local workspace candidates expose canonical local_workspace source and reject coordination guidance files", async () => {
  const agentId = `executor-guidance-boundary-${Date.now()}`;
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

    const discovery = await summarizeLocalAgentDiscovery({ includeLocalWorkspace: true });
    const candidate = discovery.localWorkspaceResidue.find((entry) => entry.id === agentId);
    assert.equal(candidate?.source, "local_workspace");

    await assert.rejects(
      readLocalAgentGuidancePreview({
        agentId,
        fileName: "AGENTS.md",
      }),
      /unsupported guidance file/i,
    );

    await assert.rejects(
      writeLocalAgentGuidanceContent({
        payload: {
          agentId,
          fileName: "AGENTS.md",
          content: "# forbidden executor guidance\n",
        },
        logger,
      }),
      /unsupported guidance file/i,
    );

    const soulPreview = await readLocalAgentGuidancePreview({
      agentId,
      fileName: "SOUL.md",
    });
    assert.equal(soulPreview.ok, true);
    assert.equal(soulPreview.fileName, "SOUL.md");
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});
