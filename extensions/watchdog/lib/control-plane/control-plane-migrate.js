// control-plane-migrate.js — one-shot boot-time lift from legacy
// workspaces/controller/ paths into control-plane/. Safe to run every boot:
// it never overwrites existing new-path data, and never deletes old-path
// data (operators can clean up legacy controller workspace after confirming
// the new location has everything).

import { access, copyFile, cp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  CONTROL_PLANE_PATHS,
  CONTROL_PLANE_ROOT,
  LEGACY_CONTROLLER_PATHS,
} from "./control-plane-paths.js";
import { normalizeGraphEdges } from "../agent/agent-graph.js";

async function pathExists(p) {
  try { await access(p); return true; } catch { return false; }
}

async function pathIsDir(p) {
  try { return (await stat(p)).isDirectory(); } catch { return false; }
}

async function copyFileIfMissing(src, dest) {
  if (!(await pathExists(src))) return { changed: false, action: "missing" };
  if (await pathExists(dest)) return { changed: false, action: "already_exists" };
  await mkdir(dirname(dest), { recursive: true });
  await copyFile(src, dest);
  return { changed: true, action: "copied" };
}

async function copyDirIfMissing(src, dest) {
  if (!(await pathIsDir(src))) return { changed: false, action: "missing" };
  if (await pathExists(dest)) return { changed: false, action: "already_exists" };
  await mkdir(dirname(dest), { recursive: true });
  await cp(src, dest, { recursive: true });
  return { changed: true, action: "copied" };
}

function migrationStateFileFor(controlPlaneRoot, controlPlanePaths) {
  return controlPlanePaths.migrationStateFile || join(controlPlaneRoot, "control-plane-migration-state.json");
}

async function loadMigrationState(controlPlaneRoot, controlPlanePaths) {
  const filePath = migrationStateFileFor(controlPlaneRoot, controlPlanePaths);
  try {
    const parsed = JSON.parse(await readFile(filePath, "utf8"));
    return {
      version: 1,
      keys: parsed?.keys && typeof parsed.keys === "object" ? parsed.keys : {},
    };
  } catch {
    return { version: 1, keys: {} };
  }
}

async function saveMigrationState(controlPlaneRoot, controlPlanePaths, state) {
  const filePath = migrationStateFileFor(controlPlaneRoot, controlPlanePaths);
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify({
    version: 1,
    keys: state?.keys && typeof state.keys === "object" ? state.keys : {},
    updatedAt: new Date().toISOString(),
  }, null, 2), "utf8");
}

async function readGraphFile(filePath) {
  try {
    const parsed = JSON.parse(await readFile(filePath, "utf8"));
    return {
      ...parsed,
      edges: normalizeGraphEdges(parsed?.edges),
    };
  } catch {
    return { edges: [] };
  }
}

function edgeKey(edge) {
  return `${edge.from}\u0000${edge.to}`;
}

async function mergeGraphFile(src, dest) {
  if (!(await pathExists(src))) return { changed: false, action: "missing" };
  if (!(await pathExists(dest))) {
    await mkdir(dirname(dest), { recursive: true });
    await copyFile(src, dest);
    return { changed: true, action: "copied" };
  }

  const current = await readGraphFile(dest);
  const legacy = await readGraphFile(src);
  const mergedEdges = [...current.edges];
  const seen = new Set(mergedEdges.map(edgeKey));
  let added = 0;
  for (const edge of legacy.edges) {
    const key = edgeKey(edge);
    if (seen.has(key)) continue;
    seen.add(key);
    mergedEdges.push(edge);
    added += 1;
  }
  if (added === 0) {
    return { changed: false, action: "already_exists" };
  }

  await mkdir(dirname(dest), { recursive: true });
  await writeFile(dest, JSON.stringify({
    ...current,
    edges: mergedEdges,
  }, null, 2), "utf8");
  return { changed: true, action: "merged", addedEdges: added };
}

function shouldRecordMigration(result) {
  return ["copied", "merged", "already_exists"].includes(result?.action);
}

function recordMigration(state, key, result, src, dest) {
  state.keys[key] = {
    completedAt: new Date().toISOString(),
    action: result.action,
    src,
    dest,
    ...(Number.isFinite(result.addedEdges) ? { addedEdges: result.addedEdges } : {}),
  };
}

export async function migrateControllerRootedStoresForPaths({
  controlPlaneRoot,
  controlPlanePaths,
  legacyControllerPaths,
  logger = null,
} = {}) {
  if (!controlPlaneRoot || !controlPlanePaths || !legacyControllerPaths) {
    throw new TypeError("migrateControllerRootedStoresForPaths requires controlPlaneRoot, controlPlanePaths, and legacyControllerPaths");
  }
  await mkdir(controlPlaneRoot, { recursive: true });
  const migrationState = await loadMigrationState(controlPlaneRoot, controlPlanePaths);
  const migrated = [];
  let stateChanged = false;
  let skippedCompleted = 0;
  const pairs = [
    ["contractsDir", copyDirIfMissing],
    ["stateFile", copyFileIfMissing],
    ["queueStateFile", copyFileIfMissing],
    ["outputDir", copyDirIfMissing],
    ["conversationsDir", copyDirIfMissing],
    ["adminChangeSetsDir", copyDirIfMissing],
    ["taskStateFile", copyFileIfMissing],
    ["systemActionDeliveryTicketsFile", copyFileIfMissing],
    ["agentDefaultSkillsFile", copyFileIfMissing],
    ["agentJoinRegistryFile", copyFileIfMissing],
    ["agentGraphFile", copyFileIfMissing],
    ["graphLoopRegistryFile", copyFileIfMissing],
    ["automationRuntimeFile", copyFileIfMissing],
    ["automationRegistryFile", copyFileIfMissing],
    ["scheduleRegistryFile", copyFileIfMissing],
    ["scheduleMaterializerFile", copyFileIfMissing],
    ["guidanceDriftStateFile", copyFileIfMissing],
  ];
  for (const [key, copier] of pairs) {
    if (migrationState.keys[key]?.completedAt) {
      skippedCompleted += 1;
      continue;
    }
    const src = legacyControllerPaths[key];
    const dest = controlPlanePaths[key];
    try {
      const result = key === "agentGraphFile"
        ? await mergeGraphFile(src, dest)
        : await copier(src, dest);
      if (shouldRecordMigration(result)) {
        recordMigration(migrationState, key, result, src, dest);
        stateChanged = true;
      }
      if (result?.changed) {
        migrated.push({ key, src, dest, action: result.action });
      }
    } catch (error) {
      logger?.warn?.(`[control-plane] migrate ${key} failed: ${error?.message || error}`);
    }
  }
  if (stateChanged) {
    await saveMigrationState(controlPlaneRoot, controlPlanePaths, migrationState);
  }
  if (migrated.length > 0) {
    logger?.info?.(`[control-plane] migrated ${migrated.length} legacy paths: ${migrated.map((m) => `${m.key}:${m.action}`).join(", ")}`);
  }
  return { migrated, skipped: migrated.length === 0 && skippedCompleted > 0 };
}

export async function migrateControllerRootedStores({ logger = null } = {}) {
  return migrateControllerRootedStoresForPaths({
    controlPlaneRoot: CONTROL_PLANE_ROOT,
    controlPlanePaths: CONTROL_PLANE_PATHS,
    legacyControllerPaths: LEGACY_CONTROLLER_PATHS,
    logger,
  });
}
