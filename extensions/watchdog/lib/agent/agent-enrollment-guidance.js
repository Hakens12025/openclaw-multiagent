// lib/agent-enrollment-guidance.js — guidance preview & write (split from agent-enrollment.js)

import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  loadConfig,
  runAgentAdminWrite,
} from "./admin/agent-admin-store.js";
import {
  expandHomePath,
  composeAgentBinding,
  loadAgentCardProjection,
} from "../effective-profile-composer.js";
import { normalizeString, uniqueStrings } from "../core/normalize.js";
import { defaultAgentWorkspace } from "../state/state-agent-helpers.js";
import { MANAGED_BOOTSTRAP_MARKER } from "../prompt/managed-doc-markers.js";
import { syncAgentWorkspaceGuidance } from "../workspace-guidance-writer.js";
import {
  findDiscoveredAgentEntry,
  GUIDANCE_FILES,
  EDITABLE_GUIDANCE_FILES,
  OPTIONAL_GUIDANCE_FILES,
  compactHomePath,
  getManagedGuidanceFilesForRole,
  summarizeLocalAgentDiscovery,
} from "./agent-enrollment-discovery.js";
import { scanWorkspaceGuidanceDrift } from "./agent-guidance-drift.js";
import {
  backupWorkspaceGuidanceFiles,
  pruneWorkspaceGuidanceBackups,
  GUIDANCE_BACKUP_RETENTION,
} from "./agent-guidance-backup.js";

function parseRequestedGuidanceFiles(rawValue, allowedFiles = GUIDANCE_FILES) {
  const values = Array.isArray(rawValue)
    ? rawValue
    : (typeof rawValue === "string" ? rawValue.split(/[\n,]+/g) : []);
  const normalizedValues = uniqueStrings(values
    .map((entry) => normalizeString(entry))
    .filter(Boolean));
  const allowed = new Set(allowedFiles);
  return {
    valid: normalizedValues.filter((entry) => allowed.has(entry)),
    invalid: normalizedValues.filter((entry) => !allowed.has(entry)),
  };
}

function normalizeRequestedGuidanceFiles(rawValue, allowedFiles = GUIDANCE_FILES) {
  return parseRequestedGuidanceFiles(rawValue, allowedFiles).valid;
}

function normalizeManualGuidanceContent(rawValue) {
  let content = typeof rawValue === "string" ? rawValue : "";
  content = content.replace(/\r\n/g, "\n");
  if (content.startsWith(`${MANAGED_BOOTSTRAP_MARKER}\n`)) {
    content = content.slice(MANAGED_BOOTSTRAP_MARKER.length + 1);
  } else if (content.startsWith(MANAGED_BOOTSTRAP_MARKER)) {
    content = content.slice(MANAGED_BOOTSTRAP_MARKER.length);
  }
  return content;
}

export { normalizeRequestedGuidanceFiles, normalizeManualGuidanceContent };

function getAllowedGuidanceFilesForDiscoveredAgent(agent) {
  // Per-role managed/expected files + optional overrides (WAKE.md): the optional ones are writable for
  // any role but never counted toward the expected/missing accounting.
  return [...getManagedGuidanceFilesForRole(agent?.detectedRole), ...OPTIONAL_GUIDANCE_FILES];
}

function assertAllowedGuidanceFile(agent, fileName) {
  const normalizedFileName = normalizeString(fileName);
  const allowedFiles = getAllowedGuidanceFilesForDiscoveredAgent(agent);
  if (allowedFiles.includes(normalizedFileName)) {
    return normalizedFileName;
  }
  throw new Error(
    `unsupported guidance file for ${agent?.id || "unknown"} `
    + `(${agent?.detectedRole || "agent"}): ${normalizedFileName || "--"}`,
  );
}

export async function readLocalAgentGuidancePreview({
  agentId,
  fileName,
}) {
  const normalizedAgentId = normalizeString(agentId);
  const normalizedFileName = normalizeString(fileName);
  if (!normalizedAgentId) {
    throw new Error("missing agentId");
  }
  if (!EDITABLE_GUIDANCE_FILES.includes(normalizedFileName)) {
    throw new Error(`unsupported guidance file: ${normalizedFileName || "--"}`);
  }

  const discovery = await summarizeLocalAgentDiscovery({ includeLocalWorkspace: true });
  const agent = findDiscoveredAgentEntry(discovery, normalizedAgentId);
  if (!agent) {
    throw new Error(`agent not found: ${normalizedAgentId}`);
  }
  const allowedFileName = assertAllowedGuidanceFile(agent, normalizedFileName);

  const workspaceDir = resolve(
    expandHomePath(agent.workspacePath) || agent.workspacePath || defaultAgentWorkspace(normalizedAgentId),
  );
  const previewPath = join(workspaceDir, allowedFileName);
  try {
    const content = await readFile(previewPath, "utf8");
    return {
      ok: true,
      agentId: normalizedAgentId,
      fileName: allowedFileName,
      workspacePath: compactHomePath(workspaceDir),
      guidanceState: content.includes(MANAGED_BOOTSTRAP_MARKER) ? "managed" : "custom",
      exists: true,
      content,
    };
  } catch (error) {
    if (error?.code === "ENOENT") {
      return {
        ok: true,
        agentId: normalizedAgentId,
        fileName: allowedFileName,
        workspacePath: compactHomePath(workspaceDir),
        guidanceState: "missing",
        exists: false,
        content: "",
      };
    }
    throw error;
  }
}

export async function writeLocalAgentGuidanceContent({
  payload,
  logger = null,
  onAlert = null,
}) {
  return runAgentAdminWrite(async () => {
    const normalizedAgentId = normalizeString(payload?.agentId);
    const normalizedFileName = normalizeString(payload?.fileName);
    if (!normalizedAgentId) {
      throw new Error("missing agentId");
    }
    if (!EDITABLE_GUIDANCE_FILES.includes(normalizedFileName)) {
      throw new Error(`unsupported guidance file: ${normalizedFileName || "--"}`);
    }

    const discovery = await summarizeLocalAgentDiscovery({ includeLocalWorkspace: true });
    const agent = findDiscoveredAgentEntry(discovery, normalizedAgentId);
    if (!agent) {
      throw new Error(`agent not found: ${normalizedAgentId}`);
    }
    const allowedFileName = assertAllowedGuidanceFile(agent, normalizedFileName);

    const workspaceDir = resolve(
      expandHomePath(agent.workspacePath) || agent.workspacePath || defaultAgentWorkspace(normalizedAgentId),
    );
    const nextContent = normalizeManualGuidanceContent(payload?.content);
    await writeFile(join(workspaceDir, allowedFileName), nextContent, "utf8");

    const updatedDiscovery = await summarizeLocalAgentDiscovery({ includeLocalWorkspace: true });
    const updatedAgent = findDiscoveredAgentEntry(updatedDiscovery, normalizedAgentId);
    logger?.info?.(
      `[watchdog] local agent guidance written: ${normalizedAgentId} `
      + `(file=${allowedFileName}, bytes=${Buffer.byteLength(nextContent, "utf8")})`,
    );
    onAlert?.({
      type: "agent_guidance_written",
      agentId: normalizedAgentId,
      fileName: allowedFileName,
      status: updatedAgent?.status || null,
      ts: Date.now(),
    });

    return {
      ok: true,
      action: "guidance_write",
      agentId: normalizedAgentId,
      fileName: allowedFileName,
      contentBytes: Buffer.byteLength(nextContent, "utf8"),
      guidanceState: "custom",
      agent: updatedAgent,
      discovery: updatedDiscovery,
    };
  });
}

export async function takeOverLocalAgentGuidance({
  payload,
  logger = null,
  onAlert = null,
}) {
  return runAgentAdminWrite(async () => {
    const config = await loadConfig();
    const agentId = normalizeString(payload?.agentId);
    if (!agentId) {
      throw new Error("missing agentId");
    }
    const agent = config.agents.list.find((entry) => entry?.id === agentId) || null;
    if (!agent) {
      throw new Error(`agent not found: ${agentId}`);
    }
    const rawRequestedFiles = payload?.files;
    const hasExplicitRequestedFiles = Array.isArray(rawRequestedFiles)
      ? rawRequestedFiles.some((entry) => normalizeString(entry))
      : (typeof rawRequestedFiles === "string" && rawRequestedFiles.trim() !== "");

    const card = await loadAgentCardProjection(agent);
    const binding = composeAgentBinding({
      config,
      agentConfig: agent,
      card,
    });
    const allowedFiles = getManagedGuidanceFilesForRole(binding.roleRef);
    const { valid: requestedFiles, invalid: invalidRequestedFiles } = parseRequestedGuidanceFiles(
      payload?.files,
      allowedFiles,
    );
    if (invalidRequestedFiles.length > 0) {
      throw new Error(
        `unsupported guidance files for ${binding.roleRef}: ${invalidRequestedFiles.join(", ")}`,
      );
    }
    if (hasExplicitRequestedFiles && requestedFiles.length === 0) {
      throw new Error(`no valid guidance files requested for ${binding.roleRef}`);
    }

    const backupEnabled = payload?.backup !== false;
    const workspaceDir = binding.workspace?.effective || defaultAgentWorkspace(agentId);

    const scanBefore = await scanWorkspaceGuidanceDrift({ label: "takeover-pre" });
    const scanBeforeForAgent = scanBefore.perAgent.find((entry) => entry.agentId === agentId) || null;

    const filesToBackup = requestedFiles.length > 0
      ? requestedFiles
      : [...getManagedGuidanceFilesForRole(binding.roleRef)];
    let backupPaths = [];
    let backupDir = null;
    if (backupEnabled) {
      const backup = await backupWorkspaceGuidanceFiles({
        workspaceDir,
        fileNames: filesToBackup,
      });
      backupPaths = backup.backupPaths;
      backupDir = backup.backupDir;
    }

    const updatedFiles = await syncAgentWorkspaceGuidance({
      agentId,
      role: binding.roleRef,
      skills: binding.skills?.effective || [],
      workspaceDir,
      overwriteCustomGuidance: requestedFiles.length === 0,
      overwriteCustomGuidanceFiles: requestedFiles,
    });

    let prunedBackups = [];
    if (backupEnabled) {
      const pruneResult = await pruneWorkspaceGuidanceBackups({
        workspaceDir,
        keep: GUIDANCE_BACKUP_RETENTION,
      });
      prunedBackups = pruneResult.removed;
    }

    const scanAfter = await scanWorkspaceGuidanceDrift({ label: "takeover-post" });
    const scanAfterForAgent = scanAfter.perAgent.find((entry) => entry.agentId === agentId) || null;

    const discovery = await summarizeLocalAgentDiscovery();
    const enrolled = discovery.agents.find((entry) => entry.id === agentId) || null;
    logger?.info?.(
      `[watchdog] local agent guidance taken over: ${agentId} `
      + `(status=${enrolled?.status || "unknown"}, `
      + `drift_before=${scanBeforeForAgent?.driftCount ?? "?"}, `
      + `drift_after=${scanAfterForAgent?.driftCount ?? "?"}, `
      + `backups=${backupPaths.length})`,
    );
    onAlert?.({
      type: "agent_guidance_taken_over",
      agentId,
      status: enrolled?.status || null,
      requestedFiles: requestedFiles.length > 0
        ? requestedFiles
        : [...getManagedGuidanceFilesForRole(binding.roleRef)],
      updatedFiles: updatedFiles.filter((entry) => entry.updated).map((entry) => entry.name),
      backupPaths,
      driftBefore: scanBeforeForAgent?.driftCount ?? null,
      driftAfter: scanAfterForAgent?.driftCount ?? null,
      ts: Date.now(),
    });

    return {
      ok: true,
      action: "guidance_takeover",
      agentId,
      requestedFiles: requestedFiles.length > 0
        ? requestedFiles
        : [...getManagedGuidanceFilesForRole(binding.roleRef)],
      updatedFiles,
      backup: {
        enabled: backupEnabled,
        backupDir,
        backupPaths,
        prunedBackups,
        retention: GUIDANCE_BACKUP_RETENTION,
      },
      scanBefore: scanBeforeForAgent,
      scanAfter: scanAfterForAgent,
      agent: enrolled,
      discovery,
    };
  });
}
