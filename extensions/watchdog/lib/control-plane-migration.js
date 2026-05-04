import { access, copyFile, mkdir, readdir, rename, rm, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  OC,
  CONTRACTS_DIR,
  QUEUE_STATE_FILE,
  STATE_FILE,
  ADMIN_CHANGE_SET_DIR,
  AGENT_DEFAULT_SKILLS_STORE,
  AGENT_GRAPH_FILE,
  AGENT_JOIN_STORE,
  AUTOMATION_RUNTIME_STORE,
  AUTOMATION_STORE,
  CONVERSATIONS_DIR,
  GRAPH_LOOP_FILE,
  SCHEDULE_MATERIALIZER_STORE,
  SCHEDULE_STORE,
  SYSTEM_ACTION_DELIVERY_TICKET_STORE,
} from "./state-paths.js";

const DEFAULT_PATHS = Object.freeze({
  legacyAdminChangeSetDir: join(OC, "workspaces", "controller", "admin-change-sets"),
  legacyAgentDefaultSkillsStore: join(OC, "workspaces", "controller", ".agent-default-skills.json"),
  legacyAgentGraphFile: join(OC, "workspaces", "controller", "agent_graph.json"),
  legacyAgentJoinStore: join(OC, "workspaces", "controller", ".watchdog-agent-joins.json"),
  legacyAutomationRuntimeStore: join(OC, "workspaces", "controller", ".watchdog-automation-runtime.json"),
  legacyAutomationStore: join(OC, "workspaces", "controller", ".watchdog-automations.json"),
  legacyConversationsDir: join(OC, "workspaces", "controller", "conversations"),
  legacyContractsDir: join(OC, "workspaces", "controller", "contracts"),
  legacyGraphLoopFile: join(OC, "workspaces", "controller", "graph_loops.json"),
  legacyScheduleMaterializerStore: join(OC, "workspaces", "controller", ".watchdog-schedule-materializer.json"),
  legacyScheduleStore: join(OC, "workspaces", "controller", ".watchdog-schedules.json"),
  legacyStateFile: join(OC, "workspaces", "controller", ".watchdog-state.json"),
  legacyQueueStateFile: join(OC, "workspaces", "controller", ".queue-state.json"),
  legacySystemActionDeliveryTicketStore: join(OC, "workspaces", "controller", ".system-action-delivery-tickets.json"),
  adminChangeSetDir: ADMIN_CHANGE_SET_DIR,
  agentDefaultSkillsStore: AGENT_DEFAULT_SKILLS_STORE,
  agentGraphFile: AGENT_GRAPH_FILE,
  agentJoinStore: AGENT_JOIN_STORE,
  automationRuntimeStore: AUTOMATION_RUNTIME_STORE,
  automationStore: AUTOMATION_STORE,
  conversationsDir: CONVERSATIONS_DIR,
  contractsDir: CONTRACTS_DIR,
  graphLoopFile: GRAPH_LOOP_FILE,
  scheduleMaterializerStore: SCHEDULE_MATERIALIZER_STORE,
  scheduleStore: SCHEDULE_STORE,
  stateFile: STATE_FILE,
  queueStateFile: QUEUE_STATE_FILE,
  systemActionDeliveryTicketStore: SYSTEM_ACTION_DELIVERY_TICKET_STORE,
});

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function moveFileIfDestinationMissing({ from, to, kind, logger }) {
  if (!from || !to || !(await pathExists(from))) {
    return { moved: false, conflict: null };
  }
  if (await pathExists(to)) {
    logger?.warn?.(`[control-plane] legacy ${kind} remains at ${from}; target already exists at ${to}`);
    return {
      moved: false,
      conflict: { kind, from, to, reason: "target_exists" },
    };
  }

  await mkdir(dirname(to), { recursive: true });
  try {
    await rename(from, to);
  } catch (error) {
    if (error?.code !== "EXDEV") {
      throw error;
    }
    await copyFile(from, to);
    await unlink(from);
  }

  logger?.info?.(`[control-plane] migrated legacy ${kind} to ${to}`);
  return { moved: true, conflict: null };
}

async function migrateLegacyContracts({ paths, logger }) {
  let entries = [];
  try {
    entries = await readdir(paths.legacyContractsDir, { withFileTypes: true });
  } catch {
    return { migratedFiles: 0, conflicts: [] };
  }

  let migratedFiles = 0;
  const conflicts = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) {
      continue;
    }
    const result = await moveFileIfDestinationMissing({
      from: join(paths.legacyContractsDir, entry.name),
      to: join(paths.contractsDir, entry.name),
      kind: "contract",
      logger,
    });
    if (result.moved) {
      migratedFiles += 1;
    }
    if (result.conflict) {
      conflicts.push(result.conflict);
    }
  }

  try {
    await rm(paths.legacyContractsDir, { recursive: false, force: false });
  } catch {}

  return { migratedFiles, conflicts };
}

async function migrateDirectoryContentsIfDestinationMissing({ fromDir, toDir, kind, logger }) {
  let entries = [];
  try {
    entries = await readdir(fromDir, { withFileTypes: true });
  } catch {
    return { migratedFiles: 0, conflicts: [] };
  }

  let migratedFiles = 0;
  const conflicts = [];
  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }
    const result = await moveFileIfDestinationMissing({
      from: join(fromDir, entry.name),
      to: join(toDir, entry.name),
      kind,
      logger,
    });
    if (result.moved) {
      migratedFiles += 1;
    }
    if (result.conflict) {
      conflicts.push(result.conflict);
    }
  }

  try {
    await rm(fromDir, { recursive: false, force: false });
  } catch {}

  return { migratedFiles, conflicts };
}

export async function migrateControllerRuntimeStateToControlPlane({
  paths = DEFAULT_PATHS,
  logger = null,
} = {}) {
  const normalizedPaths = {
    ...DEFAULT_PATHS,
    ...(paths && typeof paths === "object" ? paths : {}),
  };

  const migrations = [
    {
      from: normalizedPaths.legacyAgentDefaultSkillsStore,
      to: normalizedPaths.agentDefaultSkillsStore,
      kind: "agent_default_skills",
    },
    {
      from: normalizedPaths.legacyAgentGraphFile,
      to: normalizedPaths.agentGraphFile,
      kind: "agent_graph",
    },
    {
      from: normalizedPaths.legacyAgentJoinStore,
      to: normalizedPaths.agentJoinStore,
      kind: "agent_join",
    },
    {
      from: normalizedPaths.legacyAutomationRuntimeStore,
      to: normalizedPaths.automationRuntimeStore,
      kind: "automation_runtime",
    },
    {
      from: normalizedPaths.legacyAutomationStore,
      to: normalizedPaths.automationStore,
      kind: "automation",
    },
    {
      from: normalizedPaths.legacyGraphLoopFile,
      to: normalizedPaths.graphLoopFile,
      kind: "graph_loop",
    },
    {
      from: normalizedPaths.legacyScheduleMaterializerStore,
      to: normalizedPaths.scheduleMaterializerStore,
      kind: "schedule_materializer",
    },
    {
      from: normalizedPaths.legacyScheduleStore,
      to: normalizedPaths.scheduleStore,
      kind: "schedule",
    },
    {
      from: normalizedPaths.legacyStateFile,
      to: normalizedPaths.stateFile,
      kind: "state",
    },
    {
      from: normalizedPaths.legacyQueueStateFile,
      to: normalizedPaths.queueStateFile,
      kind: "queue_state",
    },
    {
      from: normalizedPaths.legacySystemActionDeliveryTicketStore,
      to: normalizedPaths.systemActionDeliveryTicketStore,
      kind: "system_action_delivery_ticket",
    },
  ];

  let migratedFiles = 0;
  const conflicts = [];
  for (const migration of migrations) {
    const result = await moveFileIfDestinationMissing({
      ...migration,
      logger,
    });
    if (result.moved) {
      migratedFiles += 1;
    }
    if (result.conflict) {
      conflicts.push(result.conflict);
    }
  }

  const contractResult = await migrateLegacyContracts({
    paths: normalizedPaths,
    logger,
  });
  const adminChangeSetResult = await migrateDirectoryContentsIfDestinationMissing({
    fromDir: normalizedPaths.legacyAdminChangeSetDir,
    toDir: normalizedPaths.adminChangeSetDir,
    kind: "admin_change_set",
    logger,
  });
  const conversationResult = await migrateDirectoryContentsIfDestinationMissing({
    fromDir: normalizedPaths.legacyConversationsDir,
    toDir: normalizedPaths.conversationsDir,
    kind: "conversation",
    logger,
  });

  return {
    migratedFiles: migratedFiles
      + contractResult.migratedFiles
      + adminChangeSetResult.migratedFiles
      + conversationResult.migratedFiles,
    conflicts: [
      ...conflicts,
      ...contractResult.conflicts,
      ...adminChangeSetResult.conflicts,
      ...conversationResult.conflicts,
    ],
  };
}
