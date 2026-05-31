import { access, cp, mkdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

import { OC } from "../state-paths.js";

export const OPERATOR_WORKSPACE = join(OC, "workspaces", "operator");
export const LEGACY_OPERATOR_WORKSPACE = join(OC, "workspaces", "platform-operator");

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function isDirectory(path) {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

export async function migrateOperatorWorkspaceForPaths({
  legacyWorkspace,
  operatorWorkspace,
  logger = null,
} = {}) {
  if (!legacyWorkspace || !operatorWorkspace) {
    throw new TypeError("migrateOperatorWorkspaceForPaths requires legacyWorkspace and operatorWorkspace");
  }
  if (!(await isDirectory(legacyWorkspace))) {
    return { changed: false, action: "missing" };
  }
  if (await pathExists(operatorWorkspace)) {
    return { changed: false, action: "already_exists" };
  }

  await mkdir(dirname(operatorWorkspace), { recursive: true });
  await cp(legacyWorkspace, operatorWorkspace, { recursive: true });
  logger?.info?.(`[operator] migrated legacy workspace ${legacyWorkspace} -> ${operatorWorkspace}`);
  return { changed: true, action: "copied" };
}

export function migrateOperatorWorkspace({ logger = null } = {}) {
  return migrateOperatorWorkspaceForPaths({
    legacyWorkspace: LEGACY_OPERATOR_WORKSPACE,
    operatorWorkspace: OPERATOR_WORKSPACE,
    logger,
  });
}
