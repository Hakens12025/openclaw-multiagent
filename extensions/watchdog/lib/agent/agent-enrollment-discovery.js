// lib/agent-enrollment-discovery.js — agent discovery & candidate scanning (split from agent-enrollment.js)

import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { readJsonFile } from "../state-file-utils.js";
import { loadConfig } from "./agent-admin-store.js";
import {
  normalizeStoredAgentModelRef,
} from "./agent-binding-store.js";
import { AGENT_ROLE } from "./agent-metadata.js";
import { normalizeAgentRole } from "./agent-identity.js";
import {
  expandHomePath,
  composeAgentBinding,
  loadAgentCardProjection,
} from "../effective-profile-composer.js";
import { normalizeString, uniqueStrings } from "../core/normalize.js";
import { HOME, OC } from "../state-paths.js";
import { MANAGED_BOOTSTRAP_MARKER } from "../soul-template-builder.js";

const GUIDANCE_FILES = Object.freeze([
  "SOUL.md",
  "AGENTS.md",
  "BUILDING-MAP.md",
  "COLLABORATION-GRAPH.md",
  "DELIVERY.md",
  "PLATFORM-GUIDE.md",
  "HEARTBEAT.md",
]);

export { GUIDANCE_FILES };

const EXECUTION_LAYER_ROLES = new Set([
  AGENT_ROLE.EXECUTOR,
  AGENT_ROLE.RESEARCHER,
  AGENT_ROLE.REVIEWER,
  AGENT_ROLE.PLANNER,
]);

const EXECUTION_LAYER_GUIDANCE_FILES = Object.freeze([
  "SOUL.md",
  "HEARTBEAT.md",
]);

export const LOCAL_WORKSPACE_SOURCE = "local_workspace";

export function getManagedGuidanceFilesForRole(role) {
  return EXECUTION_LAYER_ROLES.has(normalizeAgentRole(role))
    ? EXECUTION_LAYER_GUIDANCE_FILES
    : GUIDANCE_FILES;
}

export function compactHomePath(filePath) {
  const normalized = normalizeString(filePath);
  if (!normalized) return null;
  const resolved = resolve(normalized);
  if (resolved.startsWith(`${OC}/`) || resolved === OC) {
    return resolved.replace(OC, "~/.openclaw");
  }
  if (resolved.startsWith(`${HOME}/`) || resolved === HOME) {
    return resolved.replace(HOME, "~");
  }
  return resolved;
}

export async function readGuidanceState(workspaceDir, fileName) {
  try {
    const content = await readFile(join(workspaceDir, fileName), "utf8");
    return content.includes(MANAGED_BOOTSTRAP_MARKER) ? "managed" : "custom";
  } catch (error) {
    if (error?.code === "ENOENT") return "missing";
    throw error;
  }
}

export async function readWorkspaceCandidateIdentity(workspaceDir, fallbackId) {
  const card = await readJsonFile(join(workspaceDir, "agent-card.json"));
  const agentId = normalizeString(card?.id) || normalizeString(fallbackId);
  if (!agentId) return null;

  const soulExists = await readFile(join(workspaceDir, "SOUL.md"), "utf8")
    .then(() => true)
    .catch(() => false);
  const heartbeatExists = await readFile(join(workspaceDir, "HEARTBEAT.md"), "utf8")
    .then(() => true)
    .catch(() => false);
  if (!card && !soulExists && !heartbeatExists) {
    return null;
  }

  return {
    agentId,
    card,
    hasSoul: soulExists,
    hasHeartbeat: heartbeatExists,
  };
}

export function buildGuidanceSummary(fileStates) {
  const counts = {
    managed: 0,
    custom: 0,
    missing: 0,
  };
  for (const entry of fileStates) {
    counts[entry.state] = (counts[entry.state] || 0) + 1;
  }
  return counts;
}

export function resolveEnrollmentStatus({
  source,
  hasAgentCard,
  guidanceCounts,
  requiredGuidanceCount,
}) {
  if (source === LOCAL_WORKSPACE_SOURCE) {
    return "discovered";
  }
  if (hasAgentCard && guidanceCounts.managed === requiredGuidanceCount) {
    return "managed";
  }
  if (hasAgentCard && guidanceCounts.custom > 0) {
    return "customized";
  }
  if (hasAgentCard || guidanceCounts.managed > 0 || guidanceCounts.custom > 0) {
    return "partial";
  }
  return "unmanaged";
}

export function buildPlannedActions({
  source,
  hasAgentCard,
  guidanceFiles,
}) {
  const planned = [];
  if (source === LOCAL_WORKSPACE_SOURCE) {
    planned.push("config_registration");
  }
  if (!hasAgentCard) {
    planned.push("agent_card");
  }
  for (const entry of guidanceFiles) {
    if (entry.state === "missing") {
      planned.push(`managed_guidance:${entry.name}`);
    }
  }
  return planned;
}

export function buildAttentionReasons(guidanceFiles) {
  const reasons = [];
  for (const entry of guidanceFiles) {
    if (entry.state === "custom") {
      reasons.push(`custom_guidance:${entry.name}`);
    }
  }
  return reasons;
}

export function compareCandidates(left, right) {
  const order = {
    discovered: 0,
    unmanaged: 1,
    partial: 2,
    customized: 3,
    managed: 4,
  };
  const statusDiff = (order[left?.status] ?? 99) - (order[right?.status] ?? 99);
  if (statusDiff !== 0) return statusDiff;
  return String(left?.id || "").localeCompare(String(right?.id || ""));
}

export async function buildConfiguredCandidate(agentConfig, config = null) {
  const agentId = normalizeString(agentConfig?.id);
  if (!agentId) return null;

  const card = await loadAgentCardProjection(agentConfig);
  const binding = composeAgentBinding({
    config,
    agentConfig,
    card,
    role: null,
  });
  const role = binding.roleRef;
  const expectedGuidanceFiles = getManagedGuidanceFilesForRole(role);

  const workspaceDir = resolve(
    binding.workspace?.effective || join(OC, "workspaces", agentId),
  );
  const guidanceFiles = await Promise.all(expectedGuidanceFiles.map(async (name) => ({
    name,
    state: await readGuidanceState(workspaceDir, name),
  })));
  const guidance = buildGuidanceSummary(guidanceFiles);
  const status = resolveEnrollmentStatus({
    source: "configured",
    hasAgentCard: Boolean(card),
    guidanceCounts: guidance,
    requiredGuidanceCount: expectedGuidanceFiles.length,
  });
  const plannedActions = buildPlannedActions({
    source: "configured",
    hasAgentCard: Boolean(card),
    guidanceFiles,
  });
  const attentionReasons = buildAttentionReasons(guidanceFiles);

  return {
    id: agentId,
    name: normalizeString(card?.name) || `Agent ${agentId}`,
    description: normalizeString(card?.description) || null,
    source: "configured",
    status,
    joinable: plannedActions.length > 0,
    needsAttention: attentionReasons.length > 0,
    detectedRole: role,
    model: normalizeStoredAgentModelRef(binding.model?.ref || agentConfig?.model),
    workspacePath: workspaceDir,
    workspaceLabel: compactHomePath(workspaceDir),
    gateway: binding.policies?.gateway === true,
    protected: binding.policies?.protected === true,
    specialized: binding.policies?.specialized === true,
    ingressSource: normalizeString(binding.policies?.ingressSource)?.toLowerCase() || null,
    configuredExecutionPolicy: binding.policies?.configuredExecutionPolicy || null,
    effectiveExecutionPolicy: binding.policies?.effectiveExecutionPolicy || null,
    hasAgentCard: Boolean(card),
    guidance,
    guidanceFiles,
    plannedActions,
    attentionReasons,
    missingRequirements: uniqueStrings([...plannedActions, ...attentionReasons]),
  };
}

export async function buildWorkspaceOnlyCandidate(workspaceDir, dirName) {
  const identity = await readWorkspaceCandidateIdentity(workspaceDir, dirName);
  if (!identity?.agentId) return null;
  const role = normalizeAgentRole(identity.card?.role, identity.agentId);
  const expectedGuidanceFiles = getManagedGuidanceFilesForRole(role);
  const guidanceFiles = await Promise.all(expectedGuidanceFiles.map(async (name) => ({
    name,
    state: await readGuidanceState(workspaceDir, name),
  })));
  const guidance = buildGuidanceSummary(guidanceFiles);
  const plannedActions = buildPlannedActions({
    source: LOCAL_WORKSPACE_SOURCE,
    hasAgentCard: Boolean(identity.card),
    guidanceFiles,
  });
  const attentionReasons = buildAttentionReasons(guidanceFiles);
  return {
    id: identity.agentId,
    name: normalizeString(identity.card?.name) || `Agent ${identity.agentId}`,
    description: normalizeString(identity.card?.description) || null,
    source: LOCAL_WORKSPACE_SOURCE,
    status: "discovered",
    joinable: plannedActions.length > 0,
    needsAttention: attentionReasons.length > 0,
    detectedRole: role,
    model: null,
    workspacePath: workspaceDir,
    workspaceLabel: compactHomePath(workspaceDir),
    gateway: false,
    protected: false,
    specialized: false,
    ingressSource: null,
    configuredExecutionPolicy: null,
    effectiveExecutionPolicy: null,
    hasAgentCard: Boolean(identity.card),
    guidance,
    guidanceFiles,
    plannedActions,
    attentionReasons,
    missingRequirements: uniqueStrings([...plannedActions, ...attentionReasons]),
  };
}

export async function listWorkspaceOnlyCandidates(configuredIds) {
  let entries = [];
  try {
    entries = await readdir(join(OC, "workspaces"), { withFileTypes: true });
  } catch {
    entries = [];
  }

  const candidates = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const workspaceDir = join(OC, "workspaces", entry.name);
    const candidate = await buildWorkspaceOnlyCandidate(workspaceDir, entry.name);
    if (!candidate?.id) continue;
    if (configuredIds.has(candidate.id)) continue;
    candidates.push(candidate);
  }
  return candidates;
}

function buildDiscoveryCounts(agents) {
  const list = Array.isArray(agents) ? agents : [];
  return {
    total: list.length,
    configured: list.filter((entry) => entry.source === "configured").length,
    localWorkspace: list.filter((entry) => entry.source === LOCAL_WORKSPACE_SOURCE).length,
    managed: list.filter((entry) => entry.status === "managed").length,
    partial: list.filter((entry) => entry.status === "partial").length,
    customized: list.filter((entry) => entry.status === "customized").length,
    unmanaged: list.filter((entry) => entry.status === "unmanaged").length,
    discovered: list.filter((entry) => entry.status === "discovered").length,
    attention: list.filter((entry) => entry.needsAttention === true).length,
    joinable: list.filter((entry) => entry.joinable === true).length,
  };
}

function buildCandidateCounts({
  configuredCandidates,
  localWorkspaceResidue,
}) {
  const configuredList = Array.isArray(configuredCandidates) ? configuredCandidates : [];
  const localResidueList = Array.isArray(localWorkspaceResidue) ? localWorkspaceResidue : [];
  return {
    total: configuredList.length + localResidueList.length,
    configured: configuredList.length,
    localWorkspace: localResidueList.length,
  };
}

export function findDiscoveredAgentEntry(discovery, agentId) {
  const normalizedAgentId = normalizeString(agentId);
  if (!normalizedAgentId) return null;
  const configuredAgents = Array.isArray(discovery?.agents) ? discovery.agents : [];
  const localWorkspaceResidue = Array.isArray(discovery?.localWorkspaceResidue)
    ? discovery.localWorkspaceResidue
    : [];
  return [...configuredAgents, ...localWorkspaceResidue]
    .find((entry) => entry?.id === normalizedAgentId) || null;
}

export async function summarizeLocalAgentDiscovery(options = {}) {
  const includeLocalWorkspace = options?.includeLocalWorkspace === true;
  const config = await loadConfig();
  const configured = await Promise.all(
    (Array.isArray(config?.agents?.list) ? config.agents.list : [])
      .map((agentConfig) => buildConfiguredCandidate(agentConfig, config)),
  );
  const configuredCandidates = configured.filter(Boolean);
  const configuredIds = new Set(configuredCandidates.map((entry) => entry.id));
  const localWorkspaceCandidates = includeLocalWorkspace
    ? await listWorkspaceOnlyCandidates(configuredIds)
    : [];
  const agents = [...configuredCandidates].sort(compareCandidates);
  const candidates = agents.filter((entry) => entry.joinable === true);
  const localWorkspaceResidue = localWorkspaceCandidates.sort(compareCandidates);

  return {
    agents,
    counts: buildDiscoveryCounts(agents),
    candidates,
    candidateCounts: buildCandidateCounts({
      configuredCandidates: candidates,
      localWorkspaceResidue,
    }),
    localWorkspaceResidue,
    localWorkspaceResidueCounts: buildDiscoveryCounts(localWorkspaceResidue),
  };
}
