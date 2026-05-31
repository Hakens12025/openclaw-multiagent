import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

import { migrateControllerRootedStoresForPaths } from "../lib/control-plane/control-plane-migrate.js";

const tempRoot = await mkdtemp(join(tmpdir(), "openclaw-control-plane-migrate-"));
const controlRoot = join(tempRoot, "control-plane");
const legacyRoot = join(tempRoot, "workspaces", "controller");

function buildPaths(root, legacy = false) {
  return {
    root,
    contractsDir: join(root, "contracts"),
    stateFile: join(root, legacy ? ".watchdog-state.json" : "watchdog-state.json"),
    queueStateFile: join(root, legacy ? ".queue-state.json" : "queue-state.json"),
    outputDir: join(root, "output"),
    conversationsDir: join(root, "conversations"),
    adminChangeSetsDir: join(root, "admin-change-sets"),
    taskStateFile: join(root, legacy ? "TASK_STATE.md" : "task-state.md"),
    systemActionDeliveryTicketsFile: join(root, legacy ? ".system-action-delivery-tickets.json" : "system-action-delivery-tickets.json"),
    agentDefaultSkillsFile: join(root, legacy ? ".agent-default-skills.json" : "agent-default-skills.json"),
    agentJoinRegistryFile: join(root, legacy ? ".watchdog-agent-joins.json" : "agent-join-registry.json"),
    agentGraphFile: join(root, legacy ? "agent_graph.json" : "agent-graph.json"),
    graphLoopRegistryFile: join(root, legacy ? "graph_loops.json" : "graph-loop-registry.json"),
    automationRuntimeFile: join(root, legacy ? ".watchdog-automation-runtime.json" : "automation-runtime.json"),
    automationRegistryFile: join(root, legacy ? ".watchdog-automations.json" : "automation-registry.json"),
    scheduleRegistryFile: join(root, legacy ? ".watchdog-schedules.json" : "schedule-registry.json"),
    scheduleMaterializerFile: join(root, legacy ? ".watchdog-schedule-materializer.json" : "schedule-materializer.json"),
    guidanceDriftStateFile: join(root, legacy ? ".guidance-drift-state.json" : "guidance-drift-state.json"),
    migrationStateFile: join(root, "control-plane-migration-state.json"),
  };
}

const CONTROL_PLANE_PATHS = buildPaths(controlRoot);
const LEGACY_CONTROLLER_PATHS = buildPaths(legacyRoot, true);

async function writeJson(filePath, value) {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(value, null, 2), "utf8");
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

test("control-plane migration backfills graph even when state file already exists", async () => {
  await rm(tempRoot, { recursive: true, force: true });
  await mkdir(controlRoot, { recursive: true });
  await mkdir(legacyRoot, { recursive: true });

  await writeJson(CONTROL_PLANE_PATHS.stateFile, { savedAt: 1 });
  await writeJson(CONTROL_PLANE_PATHS.agentGraphFile, {
    edges: [
      { from: "worker-3", to: "worker-4", label: "runtime-loop" },
    ],
  });
  await writeJson(LEGACY_CONTROLLER_PATHS.queueStateFile, { targets: { worker: { queue: [] } } });
  await writeJson(LEGACY_CONTROLLER_PATHS.agentGraphFile, {
    edges: [
      { from: "controller", to: "planner", label: "ingress" },
      { from: "planner", to: "worker", label: "default-execution" },
      { from: "worker", to: "worker2" },
      { from: "worker-3", to: "worker-4", label: "legacy-duplicate" },
    ],
  });

  const first = await migrateControllerRootedStoresForPaths({
    controlPlaneRoot: controlRoot,
    controlPlanePaths: CONTROL_PLANE_PATHS,
    legacyControllerPaths: LEGACY_CONTROLLER_PATHS,
    logger: null,
  });

  assert.equal(first.skipped, false);
  assert.equal((await readJson(CONTROL_PLANE_PATHS.queueStateFile)).targets.worker.queue.length, 0);

  const migratedGraph = await readJson(CONTROL_PLANE_PATHS.agentGraphFile);
  assert.deepEqual(
    migratedGraph.edges.map((edge) => `${edge.from}->${edge.to}`),
    [
      "worker-3->worker-4",
      "controller->planner",
      "planner->worker",
      "worker->worker2",
    ],
  );
  assert.equal(migratedGraph.edges[0].label, "runtime-loop");

  const migrationState = await readJson(CONTROL_PLANE_PATHS.migrationStateFile);
  assert.equal(migrationState.keys.agentGraphFile.action, "merged");
  assert.equal(migrationState.keys.queueStateFile.action, "copied");

  await writeJson(CONTROL_PLANE_PATHS.agentGraphFile, { edges: [] });
  const second = await migrateControllerRootedStoresForPaths({
    controlPlaneRoot: controlRoot,
    controlPlanePaths: CONTROL_PLANE_PATHS,
    legacyControllerPaths: LEGACY_CONTROLLER_PATHS,
    logger: null,
  });

  assert.equal(second.migrated.length, 0);
  assert.deepEqual((await readJson(CONTROL_PLANE_PATHS.agentGraphFile)).edges, []);
});

test.after(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});
