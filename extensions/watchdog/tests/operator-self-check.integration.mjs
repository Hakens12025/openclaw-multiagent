// operator-self-check.test.js — proves the operator meta-agent can exercise all 6 system
// capabilities ONLY via CLI-system (executeOperatorExecutablePlan → executeCliSystemSurface,
// actor:"operator"), and that structure actually changes. Two phases so the edge created in
// phase A feeds the delete step in phase B. Robust save/restore: never leaves residue in live config.
import test from "node:test";
import assert from "node:assert/strict";
import { rm, access } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

import { executeOperatorExecutablePlan } from "../lib/operator/operator-executor.js";
import { loadConfig, saveConfig } from "../lib/agent/admin/agent-admin-store.js";
import { loadGraph, hasDirectedEdge } from "../lib/agent/agent-graph.js";
import { saveGraph } from "../lib/agent/agent-graph-mutations.js";
import { listAgentRegistry } from "../lib/management/capability-registry.js";
import { getAutomationRuntimeState, deleteAutomationRuntimeState } from "../lib/automation/automation-runtime.js";
import { upsertAutomationSpec, deleteAutomationSpec } from "../lib/automation/automation-registry.js";

const logger = { info() {}, warn() {}, error() {} };

function stepOk(results, surfaceId) {
  const entry = results.find((r) => r.surfaceId === surfaceId);
  assert.ok(entry, `plan should include step ${surfaceId}`);
  assert.notEqual(entry.result?.ok, false, `operator step ${surfaceId} must succeed via CLI-system: ${JSON.stringify(entry.result)}`);
  return entry;
}

test("operator self-check: 6 capabilities via CLI-system only (create/delete agent, add/delete graph edge, author skill, governance)", async () => {
  const tag = `sc${process.pid}`;
  const aId = `sc-a-${tag}`;
  const bId = `sc-b-${tag}`;
  const skillId = `sc-skill-${tag}`;
  const autoId = `sc-auto-${tag}`;
  const skillDir = join(homedir(), ".openclaw", "skills", skillId);

  // DEEP CLONE: loadConfig() returns a cached reference; agents.create→saveConfig mutates it
  // in place, so a shallow capture would make the finally restore a no-op (residue leaks into
  // live openclaw.json). Deep-clone the pre-test truth so restore actually removes test agents.
  const origConfig = JSON.parse(JSON.stringify(await loadConfig()));
  const origGraph = JSON.parse(JSON.stringify(await loadGraph()));

  try {
    // seed a test automation SPEC (testMode → no governance pollution) for the governance op;
    // the governance handler ensures its runtime entry.
    await upsertAutomationSpec({
      id: autoId,
      objective: { description: "self-check governance probe" },
      entry: { targetAgent: "operator", message: "self-check governance probe" },
      harness: { testMode: true },
    });

    // ── Phase A: create two agents + wire a collaboration edge (operator CLI-system) ──
    const phaseA = await executeOperatorExecutablePlan({
      logger,
      plan: {
        intent: "platform_mutation",
        summary: "self-check: create agents + wire a collaboration edge",
        steps: [
          { surfaceId: "agents.create", payload: { id: aId, role: "executor", model: "demo/self-check" } },
          { surfaceId: "agents.create", payload: { id: bId, role: "executor", model: "demo/self-check" } },
          { surfaceId: "graph.edge.add", payload: { from: aId, to: bId, label: "self-check" } },
        ],
      },
    });
    assert.equal(phaseA.ok, true);
    stepOk(phaseA.results, "agents.create");
    stepOk(phaseA.results, "graph.edge.add");

    // verify structure: both agents now registered, edge present in the live graph
    const afterCreate = (await listAgentRegistry()).map((a) => a.id);
    assert.ok(afterCreate.includes(aId) && afterCreate.includes(bId), "created agents must be in the registry");
    assert.ok(hasDirectedEdge(await loadGraph(), aId, bId), "added edge must be in the live graph");

    // ── Phase B: delete edge + author skill + governance + delete both agents (operator CLI-system) ──
    const phaseB = await executeOperatorExecutablePlan({
      logger,
      plan: {
        intent: "platform_mutation",
        summary: "self-check: delete edge + skill + governance + delete agents",
        steps: [
          { surfaceId: "graph.edge.delete", payload: { from: aId, to: bId } },
          { surfaceId: "skills.create", payload: { skillId, description: "operator self-check skill", body: "# self-check\n\nauthored by operator via CLI-system." } },
          { surfaceId: "automations.governance", payload: { automationId: autoId, disableGovernanceSnapshot: true } },
          { surfaceId: "agents.delete", payload: { agentId: aId, explicitConfirm: true, confirm: true } },
          { surfaceId: "agents.delete", payload: { agentId: bId, explicitConfirm: true, confirm: true } },
        ],
      },
    });
    assert.equal(phaseB.ok, true);
    stepOk(phaseB.results, "graph.edge.delete");
    stepOk(phaseB.results, "skills.create");
    stepOk(phaseB.results, "automations.governance");

    // verify structure changed (read truth, not just the apply return):
    assert.equal(hasDirectedEdge(await loadGraph(), aId, bId), false, "edge must be removed");
    await access(join(skillDir, "SKILL.md")); // throws if the skill was not authored
    assert.equal((await getAutomationRuntimeState(autoId))?.governanceSnapshotDisabled, true, "governance op must set the circuit breaker");
    const afterDelete = (await listAgentRegistry()).map((a) => a.id);
    assert.equal(afterDelete.includes(aId), false, "agent a must be deleted");
    assert.equal(afterDelete.includes(bId), false, "agent b must be deleted");

    // B3 safety net: destructive/structural ops carried a pre-apply snapshot (rollback handle)
    const delStep = phaseB.results.find((r) => r.surfaceId === "agents.delete");
    assert.match(delStep.result?.preApplySnapshot || "", /^SNAP-/, "destructive delete must carry a rollback snapshot");
  } finally {
    // robust restore: never leave self-check residue in live config / registry / skills / runtime.
    // restore from the pre-test deep clone AND belt-and-suspenders strip any sc-* residue.
    const restore = JSON.parse(JSON.stringify(origConfig));
    restore.agents.list = (restore.agents?.list || []).filter((a) => !/^sc-/i.test(a.id));
    await saveConfig(restore);
    await saveGraph(origGraph);
    await rm(skillDir, { recursive: true, force: true });
    await deleteAutomationSpec(autoId).catch(() => {});
    await deleteAutomationRuntimeState(autoId).catch(() => {});
  }
});
