import { access, copyFile, mkdir, readdir, rename, rm, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  OC,
  CONTRACTS_DIR,
  QUEUE_STATE_FILE,
  STATE_FILE,
} from "./state-paths.js";

const DEFAULT_PATHS = Object.freeze({
  legacyContractsDir: join(OC, "workspaces", "controller", "contracts"),
  legacyStateFile: join(OC, "workspaces", "controller", ".watchdog-state.json"),
  legacyQueueStateFile: join(OC, "workspaces", "controller", ".queue-state.json"),
  contractsDir: CONTRACTS_DIR,
  stateFile: STATE_FILE,
  queueStateFile: QUEUE_STATE_FILE,
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
      from: normalizedPaths.legacyStateFile,
      to: normalizedPaths.stateFile,
      kind: "state",
    },
    {
      from: normalizedPaths.legacyQueueStateFile,
      to: normalizedPaths.queueStateFile,
      kind: "queue_state",
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

  return {
    migratedFiles: migratedFiles + contractResult.migratedFiles,
    conflicts: [...conflicts, ...contractResult.conflicts],
  };
}
