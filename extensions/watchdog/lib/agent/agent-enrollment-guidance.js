// lib/agent-enrollment-guidance.js — guidance preview & write (split from agent-enrollment.js)

import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  loadConfig,
  runAgentAdminWrite,
} from "./agent-admin-store.js";
import {
  expandHomePath,
  composeAgentBinding,
  loadAgentCardProjection,
} from "../effective-profile-composer.js";
import { normalizeString, uniqueStrings } from "../core/normalize.js";
import { OC } from "../state-paths.js";
import { MANAGED_BOOTSTRAP_MARKER } from "../soul-template-builder.js";
import { syncAgentWorkspaceGuidance } from "../workspace-guidance-writer.js";
import {
  findDiscoveredAgentEntry,
  GUIDANCE_FILES,
  compactHomePath,
  getManagedGuidanceFilesForRole,
  summarizeLocalAgentDiscovery,
} from "./agent-enrollment-discovery.js";

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
  return getManagedGuidanceFilesForRole(agent?.detectedRole);
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
  if (!GUIDANCE_FILES.includes(normalizedFileName)) {
    throw new Error(`unsupported guidance file: ${normalizedFileName || "--"}`);
  }

  const discovery = await summarizeLocalAgentDiscovery({ includeLocalWorkspace: true });
  const agent = findDiscoveredAgentEntry(discovery, normalizedAgentId);
  if (!agent) {
    throw new Error(`agent not found: ${normalizedAgentId}`);
  }
  const allowedFileName = assertAllowedGuidanceFile(agent, normalizedFileName);

  const workspaceDir = resolve(
    expandHomePath(agent.workspacePath) || agent.workspacePath || join(OC, "workspaces", normalizedAgentId),
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
    if (!GUIDANCE_FILES.includes(normalizedFileName)) {
      throw new Error(`unsupported guidance file: ${normalizedFileName || "--"}`);
    }

    const discovery = await summarizeLocalAgentDiscovery({ includeLocalWorkspace: true });
    const agent = findDiscoveredAgentEntry(discovery, normalizedAgentId);
    if (!agent) {
      throw new Error(`agent not found: ${normalizedAgentId}`);
    }
    const allowedFileName = assertAllowedGuidanceFile(agent, normalizedFileName);

    const workspaceDir = resolve(
      expandHomePath(agent.workspacePath) || agent.workspacePath || join(OC, "workspaces", normalizedAgentId),
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
    const updatedFiles = await syncAgentWorkspaceGuidance({
      agentId,
      role: binding.roleRef,
      skills: binding.skills?.effective || [],
      workspaceDir: binding.workspace?.effective || join(OC, "workspaces", agentId),
      overwriteCustomGuidance: requestedFiles.length === 0,
      overwriteCustomGuidanceFiles: requestedFiles,
    });

    const discovery = await summarizeLocalAgentDiscovery();
    const enrolled = discovery.agents.find((entry) => entry.id === agentId) || null;
    logger?.info?.(
      `[watchdog] local agent guidance taken over: ${agentId} `
      + `(status=${enrolled?.status || "unknown"})`,
    );
    onAlert?.({
      type: "agent_guidance_taken_over",
      agentId,
      status: enrolled?.status || null,
      requestedFiles: requestedFiles.length > 0
        ? requestedFiles
        : [...getManagedGuidanceFilesForRole(binding.roleRef)],
      updatedFiles: updatedFiles.filter((entry) => entry.updated).map((entry) => entry.name),
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
      agent: enrolled,
      discovery,
    };
  });
}
