// agent-guidance-backup.js — explicit guidance takeover backup + retention.
//
// When takeover overwrites managed guidance files, we first snapshot the
// existing content into workspaces/<agentId>/.guidance-backup/<ISO-ts>/.
// Retention policy: keep the 10 most recent snapshots per agent.

import { copyFile, mkdir, readdir, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

import { OC } from "../state/state-paths.js";

export const GUIDANCE_BACKUP_DIR = ".guidance-backup";
export const GUIDANCE_BACKUP_RETENTION = 10;

function isoTimestamp(now = Date.now()) {
  return new Date(now).toISOString().replace(/[:.]/g, "-");
}

async function fileExists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function directoryExists(dir) {
  try {
    const info = await stat(dir);
    return info.isDirectory();
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

export async function backupWorkspaceGuidanceFiles({
  workspaceDir,
  fileNames = [],
  now = Date.now(),
}) {
  if (!workspaceDir || !Array.isArray(fileNames) || fileNames.length === 0) {
    return { backupDir: null, backupPaths: [] };
  }
  const stamp = isoTimestamp(now);
  const backupDir = join(workspaceDir, GUIDANCE_BACKUP_DIR, stamp);
  const backupPaths = [];
  let created = false;
  for (const name of fileNames) {
    const src = join(workspaceDir, name);
    if (!(await fileExists(src))) continue;
    if (!created) {
      await mkdir(backupDir, { recursive: true });
      created = true;
    }
    const dest = join(backupDir, name);
    await copyFile(src, dest);
    backupPaths.push(dest);
  }
  return { backupDir: created ? backupDir : null, backupPaths };
}

async function listBackupSnapshots(workspaceDir) {
  const root = join(workspaceDir, GUIDANCE_BACKUP_DIR);
  if (!(await directoryExists(root))) return [];
  const entries = await readdir(root, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

export async function pruneWorkspaceGuidanceBackups({
  workspaceDir,
  keep = GUIDANCE_BACKUP_RETENTION,
}) {
  if (!workspaceDir) return { removed: [] };
  const snapshots = await listBackupSnapshots(workspaceDir);
  if (snapshots.length <= keep) return { removed: [] };
  const removeCount = snapshots.length - keep;
  const toRemove = snapshots.slice(0, removeCount);
  const removed = [];
  for (const name of toRemove) {
    const target = join(workspaceDir, GUIDANCE_BACKUP_DIR, name);
    await rm(target, { recursive: true, force: true });
    removed.push(target);
  }
  return { removed };
}

export async function pruneAllWorkspaceGuidanceBackups({
  keep = GUIDANCE_BACKUP_RETENTION,
  logger = null,
} = {}) {
  const workspacesRoot = join(OC, "workspaces");
  if (!(await directoryExists(workspacesRoot))) return { pruned: [] };
  const entries = await readdir(workspacesRoot, { withFileTypes: true });
  const pruned = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const workspaceDir = resolve(join(workspacesRoot, entry.name));
    try {
      const result = await pruneWorkspaceGuidanceBackups({ workspaceDir, keep });
      if (result.removed.length > 0) {
        pruned.push({ agentId: entry.name, removed: result.removed });
      }
    } catch (error) {
      logger?.warn?.(`[watchdog] guidance backup prune failed for ${entry.name}: ${error?.message || error}`);
    }
  }
  return { pruned };
}
