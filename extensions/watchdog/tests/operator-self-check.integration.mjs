// operator-self-check.test.js — proves the operator meta-agent can exercise all 6 system
// capabilities ONLY via CLI-system (executeOperatorExecutablePlan → executeCliSystemSurface,
// actor:"operator"), and that structure actually changes. Two phases so the real loopId from
// compose feeds the delete step. Robust save/restore: never leaves residue in live config.
import test from "node:test";
import assert from "node:assert/strict";
import { rm, access } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

import { executeOperatorExecutablePlan } from "../lib/operator/operator-executor.js";
import { loadConfig, saveConfig } from "../lib/agent/agent-admin-store.js";
import { loadGraphLoopRegistry, saveGraphLoopRegistry } from "../lib/loop/graph-loop-registry.js";
import { listAgentRegistry } from "../lib/capability/capability-registry.js";
import { getAutomationRuntimeState, deleteAutomationRuntimeState } from "../lib/automation/automation-runtime.js";
import { upsertAutomationSpec, deleteAutomationSpec } from "../lib/automation/automation-registry.js";

const logger = { info() {}, warn() {}, error() {} };

function stepOk(results, surfaceId) {
  const entry = results.find((r) => r.surfaceId === surfaceId);
  assert.ok(entry, `plan should include step ${surfaceId}`);
  assert.notEqual(entry.result?.ok, false, `operator step ${surfaceId} must succeed via CLI-system: ${JSON.stringify(entry.result)}`);
  return entry;
}

test("operator self-check: 6 capabilities via CLI-system only (create/delete agent, compose/delete loop, author skill, governance)", async () => {
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
  const origReg = JSON.parse(JSON.stringify(await loadGraphLoopRegistry()));

  try {
    // seed a test automation SPEC (testMode → no governance pollution) for the governance op;
    // the governance handler ensures its runtime entry.
    await upsertAutomationSpec({
      id: autoId,
      objective: { description: "self-check governance probe" },
      entry: { targetAgent: "operator", message: "self-check governance probe" },
      harness: { testMode: true },
    });

    // ── Phase A: create two agents + compose a loop (operator CLI-system) ──
    const phaseA = await executeOperatorExecutablePlan({
      logger,
      plan: {
        intent: "platform_mutation",
        summary: "self-check: create agents + compose loop",
        steps: [
          { surfaceId: "agents.create", payload: { id: aId, role: "executor", model: "demo/self-check" } },
          { surfaceId: "agents.create", payload: { id: bId, role: "executor", model: "demo/self-check" } },
          { surfaceId: "graph.loop.compose", payload: { agents: [aId, bId], label: "self-check", maxRounds: 2 } },
        ],
      },
    });
    assert.equal(phaseA.ok, true);
    stepOk(phaseA.results, "agents.create");
    const composeStep = stepOk(phaseA.results, "graph.loop.compose");
    const loopId = composeStep.result?.loop?.id;
    assert.ok(loopId, "compose must return a loop id");

    // verify structure: both agents now registered, loop registered
    const afterCreate = (await listAgentRegistry()).map((a) => a.id);
    assert.ok(afterCreate.includes(aId) && afterCreate.includes(bId), "created agents must be in the registry");
    assert.ok((await loadGraphLoopRegistry()).loops.some((l) => l.id === loopId), "composed loop must be registered");

    // ── Phase B: delete loop + author skill + governance + delete both agents (operator CLI-system) ──
    const phaseB = await executeOperatorExecutablePlan({
      logger,
      plan: {
        intent: "platform_mutation",
        summary: "self-check: delete loop + skill + governance + delete agents",
        steps: [
          { surfaceId: "graph.loop.delete", payload: { loopId } },
          { surfaceId: "skills.create", payload: { skillId, description: "operator self-check skill", body: "# self-check\n\nauthored by operator via CLI-system." } },
          { surfaceId: "automations.governance", payload: { automationId: autoId, disableGovernanceSnapshot: true } },
          { surfaceId: "agents.delete", payload: { agentId: aId, explicitConfirm: true, confirm: true } },
          { surfaceId: "agents.delete", payload: { agentId: bId, explicitConfirm: true, confirm: true } },
        ],
      },
    });
    assert.equal(phaseB.ok, true);
    stepOk(phaseB.results, "graph.loop.delete");
    stepOk(phaseB.results, "skills.create");
    stepOk(phaseB.results, "automations.governance");

    // verify structure changed (read truth, not just the apply return):
    assert.equal((await loadGraphLoopRegistry()).loops.some((l) => l.id === loopId), false, "loop must be de-registered");
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
    await saveGraphLoopRegistry(origReg);
    await rm(skillDir, { recursive: true, force: true });
    await deleteAutomationSpec(autoId).catch(() => {});
    await deleteAutomationRuntimeState(autoId).catch(() => {});
  }
});
