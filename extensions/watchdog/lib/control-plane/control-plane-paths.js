// control-plane-paths.js — single location authority for runtime-owned
// control-plane stores. Runtime-owned state lives under ~/.openclaw/control-plane/
// so it doesn't share the workspaces/ tree with agent-authored workspaces.
//
// Self-contained: does not import from state-paths.js to avoid a cycle
// (state-paths re-exports CONTRACTS_DIR / STATE_FILE / QUEUE_STATE_FILE
// from here for back-compat with the existing 5 consumers).

import { homedir } from "node:os";
import { join } from "node:path";

const OC_ROOT = join(homedir(), ".openclaw");

export const CONTROL_PLANE_ROOT = join(OC_ROOT, "control-plane");

export const CONTROL_PLANE_PATHS = Object.freeze({
  root: CONTROL_PLANE_ROOT,
  contractsDir: join(CONTROL_PLANE_ROOT, "contracts"),
  stateFile: join(CONTROL_PLANE_ROOT, "watchdog-state.json"),
  queueStateFile: join(CONTROL_PLANE_ROOT, "queue-state.json"),
  outputDir: join(CONTROL_PLANE_ROOT, "output"),
  conversationsDir: join(CONTROL_PLANE_ROOT, "conversations"),
  adminChangeSetsDir: join(CONTROL_PLANE_ROOT, "admin-change-sets"),
  taskStateFile: join(CONTROL_PLANE_ROOT, "task-state.md"),
  systemActionDeliveryTicketsFile: join(CONTROL_PLANE_ROOT, "system-action-delivery-tickets.json"),
  agentDefaultSkillsFile: join(CONTROL_PLANE_ROOT, "agent-default-skills.json"),
  agentJoinRegistryFile: join(CONTROL_PLANE_ROOT, "agent-join-registry.json"),
  agentGraphFile: join(CONTROL_PLANE_ROOT, "agent-graph.json"),
  graphLoopRegistryFile: join(CONTROL_PLANE_ROOT, "graph-loop-registry.json"),
  automationRuntimeFile: join(CONTROL_PLANE_ROOT, "automation-runtime.json"),
  automationRegistryFile: join(CONTROL_PLANE_ROOT, "automation-registry.json"),
  scheduleRegistryFile: join(CONTROL_PLANE_ROOT, "schedule-registry.json"),
  scheduleMaterializerFile: join(CONTROL_PLANE_ROOT, "schedule-materializer.json"),
  guidanceDriftStateFile: join(CONTROL_PLANE_ROOT, "guidance-drift-state.json"),
  migrationStateFile: join(CONTROL_PLANE_ROOT, "control-plane-migration-state.json"),
  structureSnapshotsFile: join(CONTROL_PLANE_ROOT, "structure-snapshots.json"),
});

// Legacy controller-workspace mirrors; used only by the one-shot boot-time
// migration helper (see control-plane-migrate.js) to lift data from the
// pre-v5.1 location. Values are NOT derivable from CONTROL_PLANE_PATHS — the
// legacy filenames are irregular (dot-prefixed, snake_case, CamelCase).
export const LEGACY_CONTROLLER_ROOT = join(OC_ROOT, "workspaces", "controller");
export const LEGACY_CONTROLLER_PATHS = Object.freeze({
  contractsDir: join(LEGACY_CONTROLLER_ROOT, "contracts"),
  stateFile: join(LEGACY_CONTROLLER_ROOT, ".watchdog-state.json"),
  queueStateFile: join(LEGACY_CONTROLLER_ROOT, ".queue-state.json"),
  outputDir: join(LEGACY_CONTROLLER_ROOT, "output"),
  conversationsDir: join(LEGACY_CONTROLLER_ROOT, "conversations"),
  adminChangeSetsDir: join(LEGACY_CONTROLLER_ROOT, "admin-change-sets"),
  taskStateFile: join(LEGACY_CONTROLLER_ROOT, "TASK_STATE.md"),
  systemActionDeliveryTicketsFile: join(LEGACY_CONTROLLER_ROOT, ".system-action-delivery-tickets.json"),
  agentDefaultSkillsFile: join(LEGACY_CONTROLLER_ROOT, ".agent-default-skills.json"),
  agentJoinRegistryFile: join(LEGACY_CONTROLLER_ROOT, ".watchdog-agent-joins.json"),
  agentGraphFile: join(LEGACY_CONTROLLER_ROOT, "agent_graph.json"),
  graphLoopRegistryFile: join(LEGACY_CONTROLLER_ROOT, "graph_loops.json"),
  automationRuntimeFile: join(LEGACY_CONTROLLER_ROOT, ".watchdog-automation-runtime.json"),
  automationRegistryFile: join(LEGACY_CONTROLLER_ROOT, ".watchdog-automations.json"),
  scheduleRegistryFile: join(LEGACY_CONTROLLER_ROOT, ".watchdog-schedules.json"),
  scheduleMaterializerFile: join(LEGACY_CONTROLLER_ROOT, ".watchdog-schedule-materializer.json"),
  guidanceDriftStateFile: join(LEGACY_CONTROLLER_ROOT, ".guidance-drift-state.json"),
});
