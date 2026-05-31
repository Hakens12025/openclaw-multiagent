import { lstat, mkdir, readlink, symlink, unlink } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import { agentWorkspace, HOME } from "./state.js";

function normalizePath(rawPath) {
  const normalized = String(rawPath || "").replace(/^~/, HOME).trim();
  return normalized ? resolve(normalized) : "";
}

function isAbsolutePath(filePath) {
  return filePath.startsWith("/") || /^[A-Za-z]:[\\/]/.test(filePath);
}

function resolveWorkspacePath(rawPath, workspaceDir) {
  const normalized = String(rawPath || "").replace(/^~/, HOME).trim();
  if (!normalized) return "";
  if (isAbsolutePath(normalized)) {
    return resolve(normalized);
  }
  return workspaceDir ? resolve(workspaceDir, normalized) : normalized;
}

export function resolveWorkspaceContractOutputAliasPath(agentId, contractOutput) {
  const workspaceDir = typeof agentId === "string" && agentId.trim()
    ? agentWorkspace(agentId.trim())
    : "";
  const normalizedOutput = normalizePath(contractOutput);
  if (!workspaceDir || !normalizedOutput) {
    return null;
  }
  return join(workspaceDir, "output", basename(normalizedOutput));
}

export function canonicalizeContractOutputPath({
  agentId,
  rawPath,
  contractOutput,
} = {}) {
  const workspaceDir = typeof agentId === "string" && agentId.trim()
    ? agentWorkspace(agentId.trim())
    : "";
  const resolvedPath = resolveWorkspacePath(rawPath, workspaceDir);
  const normalizedOutput = normalizePath(contractOutput);
  if (!resolvedPath || !normalizedOutput) {
    return resolvedPath;
  }

  const aliasPath = resolveWorkspaceContractOutputAliasPath(agentId, normalizedOutput);
  if (aliasPath && resolvedPath === resolve(aliasPath)) {
    return normalizedOutput;
  }

  return resolvedPath;
}

export async function ensureWorkspaceContractOutputAlias({
  agentId,
  contractOutput,
  logger,
} = {}) {
  const aliasPath = resolveWorkspaceContractOutputAliasPath(agentId, contractOutput);
  const normalizedOutput = normalizePath(contractOutput);
  if (!aliasPath || !normalizedOutput) {
    return null;
  }

  if (resolve(aliasPath) === normalizedOutput) {
    try {
      const stats = await lstat(aliasPath);
      if (stats.isSymbolicLink()) {
        await unlink(aliasPath);
      }
    } catch {}
    return aliasPath;
  }

  await mkdir(dirname(aliasPath), { recursive: true });

  try {
    const stats = await lstat(aliasPath);
    if (stats.isSymbolicLink()) {
      const currentTarget = await readlink(aliasPath);
      const resolvedCurrentTarget = resolve(dirname(aliasPath), currentTarget);
      if (resolvedCurrentTarget === normalizedOutput) {
        return aliasPath;
      }
    }
    await unlink(aliasPath);
  } catch {}

  try {
    await symlink(normalizedOutput, aliasPath);
    return aliasPath;
  } catch (error) {
    logger?.warn?.(
      `[watchdog] failed to create contract.output alias for ${agentId}: ${error.message}`,
    );
    return null;
  }
}
