import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { syncAgentWorkspaceGuidance } from "../lib/workspace-guidance-writer.js";
import { AGENT_ROLE } from "../lib/agent/agent-metadata.js";
import * as soulTemplateBuilder from "../lib/soul-template-builder.js";

test("Task 7: isLegacy{Planner,Executor,Researcher,Reviewer}SoulContent are removed from soul-template-builder", () => {
  assert.equal(typeof soulTemplateBuilder.isLegacyPlannerSoulContent, "undefined");
  assert.equal(typeof soulTemplateBuilder.isLegacyExecutorSoulContent, "undefined");
  assert.equal(typeof soulTemplateBuilder.isLegacyResearcherSoulContent, "undefined");
  assert.equal(typeof soulTemplateBuilder.isLegacyReviewerSoulContent, "undefined");
});

test("startup sync does NOT auto-upgrade a no-marker legacy SOUL (Task 7)", async () => {
  const workspaceDir = await mkdtemp(join(tmpdir(), "legacy-retire-"));
  try {
    const legacyContent = "# worker-x\n\n任务执行者。唯一职责：读取 inbox 中的 Contract，按要求执行任务，将结果写入 output 路径。\n";
    await writeFile(join(workspaceDir, "SOUL.md"), legacyContent, "utf8");
    await syncAgentWorkspaceGuidance({
      agentId: "worker-x",
      role: AGENT_ROLE.EXECUTOR,
      skills: [],
      workspaceDir,
      graph: { edges: [] },
      loops: [],
    });
    const stillThere = await readFile(join(workspaceDir, "SOUL.md"), "utf8");
    assert.equal(stillThere, legacyContent, "no-marker legacy content must survive startup sync");
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("startup sync still updates a marker-managed SOUL (Task 7)", async () => {
  const workspaceDir = await mkdtemp(join(tmpdir(), "legacy-retire-marker-"));
  try {
    const managedSeed = "<!-- managed-by-watchdog:agent-bootstrap -->\n# worker-x\n\nstale body\n";
    await writeFile(join(workspaceDir, "SOUL.md"), managedSeed, "utf8");
    await syncAgentWorkspaceGuidance({
      agentId: "worker-x",
      role: AGENT_ROLE.EXECUTOR,
      skills: [],
      workspaceDir,
      graph: { edges: [] },
      loops: [],
    });
    const updated = await readFile(join(workspaceDir, "SOUL.md"), "utf8");
    assert.notEqual(updated, managedSeed, "marker-managed SOUL should be refreshed by startup sync");
    assert.match(updated, /<!-- managed-by-watchdog:agent-bootstrap -->/);
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});
