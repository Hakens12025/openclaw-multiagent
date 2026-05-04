import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, mkdir, access } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { migrateControllerRuntimeStateToControlPlane } from "../lib/control-plane-migration.js";

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function buildPaths(root) {
  return {
    legacyAdminChangeSetDir: join(root, "workspaces", "controller", "admin-change-sets"),
    legacyAgentDefaultSkillsStore: join(root, "workspaces", "controller", ".agent-default-skills.json"),
    legacyAgentGraphFile: join(root, "workspaces", "controller", "agent_graph.json"),
    legacyAgentJoinStore: join(root, "workspaces", "controller", ".watchdog-agent-joins.json"),
    legacyAutomationRuntimeStore: join(root, "workspaces", "controller", ".watchdog-automation-runtime.json"),
    legacyAutomationStore: join(root, "workspaces", "controller", ".watchdog-automations.json"),
    legacyConversationsDir: join(root, "workspaces", "controller", "conversations"),
    legacyContractsDir: join(root, "workspaces", "controller", "contracts"),
    legacyGraphLoopFile: join(root, "workspaces", "controller", "graph_loops.json"),
    legacyScheduleMaterializerStore: join(root, "workspaces", "controller", ".watchdog-schedule-materializer.json"),
    legacyScheduleStore: join(root, "workspaces", "controller", ".watchdog-schedules.json"),
    legacyStateFile: join(root, "workspaces", "controller", ".watchdog-state.json"),
    legacyQueueStateFile: join(root, "workspaces", "controller", ".queue-state.json"),
    legacySystemActionDeliveryTicketStore: join(root, "workspaces", "controller", ".system-action-delivery-tickets.json"),
    adminChangeSetDir: join(root, "control-plane", "admin-change-sets"),
    agentDefaultSkillsStore: join(root, "control-plane", "agent-default-skills.json"),
    agentGraphFile: join(root, "control-plane", "agent-graph.json"),
    agentJoinStore: join(root, "control-plane", "agent-joins.json"),
    automationRuntimeStore: join(root, "control-plane", "automation-runtime.json"),
    automationStore: join(root, "control-plane", "automations.json"),
    controlPlaneDir: join(root, "control-plane"),
    conversationsDir: join(root, "control-plane", "conversations"),
    contractsDir: join(root, "control-plane", "contracts"),
    graphLoopFile: join(root, "control-plane", "graph-loops.json"),
    scheduleMaterializerStore: join(root, "control-plane", "schedule-materializer.json"),
    scheduleStore: join(root, "control-plane", "schedules.json"),
    stateFile: join(root, "control-plane", "watchdog-state.json"),
    queueStateFile: join(root, "control-plane", "queue-state.json"),
    systemActionDeliveryTicketStore: join(root, "control-plane", "system-action-delivery-tickets.json"),
  };
}

test("migrateControllerRuntimeStateToControlPlane moves legacy runtime state into control-plane", async () => {
  const root = await mkdtemp(join(tmpdir(), "openclaw-control-plane-migration-"));
  const paths = buildPaths(root);

  try {
    await mkdir(paths.legacyContractsDir, { recursive: true });
    await writeFile(paths.legacyStateFile, JSON.stringify({ dispatchChain: ["legacy"] }), "utf8");
    await writeFile(paths.legacyQueueStateFile, JSON.stringify({ targets: { worker: {} } }), "utf8");
    await writeFile(join(paths.legacyContractsDir, "TC-MIGRATE.json"), JSON.stringify({ id: "TC-MIGRATE" }), "utf8");

    const result = await migrateControllerRuntimeStateToControlPlane({ paths });

    assert.equal(result.migratedFiles, 3);
    assert.equal(result.conflicts.length, 0);
    assert.deepEqual(JSON.parse(await readFile(paths.stateFile, "utf8")), { dispatchChain: ["legacy"] });
    assert.deepEqual(JSON.parse(await readFile(paths.queueStateFile, "utf8")), { targets: { worker: {} } });
    assert.deepEqual(
      JSON.parse(await readFile(join(paths.contractsDir, "TC-MIGRATE.json"), "utf8")),
      { id: "TC-MIGRATE" },
    );
    assert.equal(await exists(paths.legacyStateFile), false);
    assert.equal(await exists(paths.legacyQueueStateFile), false);
    assert.equal(await exists(join(paths.legacyContractsDir, "TC-MIGRATE.json")), false);

    const second = await migrateControllerRuntimeStateToControlPlane({ paths });
    assert.equal(second.migratedFiles, 0);
    assert.equal(second.conflicts.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("migrateControllerRuntimeStateToControlPlane moves legacy control-plane stores", async () => {
  const root = await mkdtemp(join(tmpdir(), "openclaw-control-plane-migration-"));
  const paths = buildPaths(root);

  try {
    await mkdir(paths.legacyAdminChangeSetDir, { recursive: true });
    await mkdir(paths.legacyConversationsDir, { recursive: true });
    await writeFile(join(paths.legacyAdminChangeSetDir, "ACS-1.json"), "admin-change-set", "utf8");
    await writeFile(join(paths.legacyConversationsDir, "qq:room.json"), "conversation", "utf8");
    await writeFile(paths.legacyAgentDefaultSkillsStore, "agent-defaults", "utf8");
    await writeFile(paths.legacyAgentGraphFile, "agent-graph", "utf8");
    await writeFile(paths.legacyAgentJoinStore, "agent-joins", "utf8");
    await writeFile(paths.legacyAutomationRuntimeStore, "automation-runtime", "utf8");
    await writeFile(paths.legacyAutomationStore, "automations", "utf8");
    await writeFile(paths.legacyGraphLoopFile, "graph-loops", "utf8");
    await writeFile(paths.legacyScheduleMaterializerStore, "schedule-materializer", "utf8");
    await writeFile(paths.legacyScheduleStore, "schedules", "utf8");
    await writeFile(paths.legacySystemActionDeliveryTicketStore, "system-action-tickets", "utf8");

    const result = await migrateControllerRuntimeStateToControlPlane({ paths });

    assert.equal(result.conflicts.length, 0);
    assert.equal(await readFile(join(paths.adminChangeSetDir, "ACS-1.json"), "utf8"), "admin-change-set");
    assert.equal(await readFile(join(paths.conversationsDir, "qq:room.json"), "utf8"), "conversation");
    assert.equal(await readFile(paths.agentDefaultSkillsStore, "utf8"), "agent-defaults");
    assert.equal(await readFile(paths.agentGraphFile, "utf8"), "agent-graph");
    assert.equal(await readFile(paths.agentJoinStore, "utf8"), "agent-joins");
    assert.equal(await readFile(paths.automationRuntimeStore, "utf8"), "automation-runtime");
    assert.equal(await readFile(paths.automationStore, "utf8"), "automations");
    assert.equal(await readFile(paths.graphLoopFile, "utf8"), "graph-loops");
    assert.equal(await readFile(paths.scheduleMaterializerStore, "utf8"), "schedule-materializer");
    assert.equal(await readFile(paths.scheduleStore, "utf8"), "schedules");
    assert.equal(await readFile(paths.systemActionDeliveryTicketStore, "utf8"), "system-action-tickets");
    assert.equal(await exists(paths.legacyAgentGraphFile), false);
    assert.equal(await exists(join(paths.legacyAdminChangeSetDir, "ACS-1.json")), false);
    assert.equal(await exists(join(paths.legacyConversationsDir, "qq:room.json")), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("migrateControllerRuntimeStateToControlPlane preserves conflicting legacy data", async () => {
  const root = await mkdtemp(join(tmpdir(), "openclaw-control-plane-migration-"));
  const paths = buildPaths(root);

  try {
    await mkdir(paths.legacyContractsDir, { recursive: true });
    await mkdir(paths.contractsDir, { recursive: true });
    await writeFile(paths.legacyStateFile, "legacy-state", "utf8");
    await writeFile(paths.stateFile, "current-state", "utf8");
    await writeFile(join(paths.legacyContractsDir, "TC-CONFLICT.json"), "legacy-contract", "utf8");
    await writeFile(join(paths.contractsDir, "TC-CONFLICT.json"), "current-contract", "utf8");

    const result = await migrateControllerRuntimeStateToControlPlane({ paths });

    assert.deepEqual(
      result.conflicts.map((entry) => entry.kind).sort(),
      ["contract", "state"].sort(),
    );
    assert.equal(await readFile(paths.stateFile, "utf8"), "current-state");
    assert.equal(await readFile(paths.legacyStateFile, "utf8"), "legacy-state");
    assert.equal(await readFile(join(paths.contractsDir, "TC-CONFLICT.json"), "utf8"), "current-contract");
    assert.equal(await readFile(join(paths.legacyContractsDir, "TC-CONFLICT.json"), "utf8"), "legacy-contract");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
