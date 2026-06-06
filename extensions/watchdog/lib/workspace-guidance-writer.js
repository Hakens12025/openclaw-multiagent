import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { atomicWriteFile } from "./state-file-utils.js";
import { AGENT_ROLE, normalizeAgentRole } from "./agent/agent-identity.js";
import { composeEffectiveProfile } from "./effective-profile-composer.js";
import { loadGraph } from "./agent/agent-graph.js";
import { composeAgentCardProjection } from "./agent/agent-card-composer.js";
import { composeEffectiveSkillRefs } from "./agent/agent-binding-policy.js";
import { readStoredAgentBinding } from "./agent/agent-binding-store.js";
import { listResolvedGraphLoops } from "./loop/graph-loop-registry.js";
import { agentWorkspace } from "./state.js";
import { MANAGED_BOOTSTRAP_MARKER, normalizeManagedDocContent } from "./managed-doc-markers.js";
import { buildSoulTemplate } from "./soul-template-builder.js";
import {
  buildHeartbeatTemplate,
  buildAgentsTemplate,
  buildBuildingMapTemplate,
  buildCollaborationGraphTemplate,
  buildDeliveryTemplate,
  buildPlatformGuideTemplate,
} from "./platform-doc-builder.js";
import { MANAGED_GUIDANCE_FILE_NAMES } from "./agent/managed-guidance-files.js";

export function buildAgentCard({ agentId, role, skills }) {
  return composeAgentCardProjection({ agentId, role, skills });
}

async function writeIfMissing(filePath, content) {
  try {
    await writeFile(filePath, content, { flag: "wx" });
  } catch (error) {
    if (error?.code !== "EEXIST") {
      throw error;
    }
  }
}

async function writeManagedFile(filePath, content, {
  legacyContents = [],
  legacyPredicates = [],
  force = false,
} = {}) {
  const normalizedContent = normalizeManagedDocContent(content);
  if (!force) {
    try {
      const existing = normalizeManagedDocContent(await readFile(filePath, "utf8"));
      const canUpdate = existing.includes(MANAGED_BOOTSTRAP_MARKER)
        || legacyContents.map((entry) => normalizeManagedDocContent(entry)).includes(existing)
        || legacyPredicates.some((predicate) => predicate(existing));
      if (!canUpdate) {
        return false;
      }
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
    }
  }

  await atomicWriteFile(filePath, normalizedContent);
  return true;
}

async function writeSoulFile(filePath, content, {
  role,
  force = false,
} = {}) {
  void role;
  const normalizedContent = normalizeManagedDocContent(content);
  if (!force) {
    try {
      const existing = normalizeManagedDocContent(await readFile(filePath, "utf8"));
      // Startup sync only updates marker-managed docs. Non-marker custom or
      // legacy content must go through explicit takeover (which force-writes).
      const canUpdate = existing.includes(MANAGED_BOOTSTRAP_MARKER);
      if (!canUpdate) {
        return false;
      }
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
    }
  }

  await atomicWriteFile(filePath, normalizedContent);
  return true;
}

const LEGACY_DELIVERY_GUIDANCE_FILE = ["RUNTIME", "RETURN.md"].join("-");
const DEFAULT_OPENCLAW_SCAFFOLD_SIGNATURES = Object.freeze({
  "AGENTS.md": Object.freeze([
    "# AGENTS.md - Your Workspace",
    "This folder is home. Treat it that way.",
  ]),
  "BOOTSTRAP.md": Object.freeze([
    "# BOOTSTRAP.md - Hello, World",
  ]),
  "IDENTITY.md": Object.freeze([
    "# IDENTITY.md - Who Am I?",
  ]),
  "USER.md": Object.freeze([
    "# USER.md - About Your Human",
  ]),
  "TOOLS.md": Object.freeze([
    "# TOOLS.md - Local Notes",
  ]),
});

function isDefaultOpenClawScaffoldFile(fileName, content) {
  const signatures = DEFAULT_OPENCLAW_SCAFFOLD_SIGNATURES[fileName];
  if (!signatures) {
    return false;
  }
  const normalized = normalizeManagedDocContent(content);
  return signatures.every((signature) => normalized.includes(signature));
}

async function removeWorkspaceFileIf(filePath, predicate) {
  try {
    const existing = normalizeManagedDocContent(await readFile(filePath, "utf8"));
    if (!predicate(existing)) {
      return false;
    }
    await unlink(filePath);
    return true;
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
    return false;
  }
}

export async function syncAgentWorkspaceGuidance({
  agentId,
  role,
  skills,
  workspaceDir,
  graph = null,
  loops = null,
  agentEntries = [],
  overwriteCustomGuidance = false,
  overwriteCustomGuidanceFiles = [],
}) {
  const effectiveGraph = graph || await loadGraph();
  const effectiveLoops = Array.isArray(loops) ? loops : await listResolvedGraphLoops({ graph: effectiveGraph });
  const forcedFiles = new Set(
    overwriteCustomGuidance === true
      ? MANAGED_GUIDANCE_FILE_NAMES
      : (Array.isArray(overwriteCustomGuidanceFiles) ? overwriteCustomGuidanceFiles : []),
  );
  await mkdir(workspaceDir, { recursive: true });

  // Execution-layer roles (worker/researcher/reviewer/planner) only get SOUL + HEARTBEAT.
  // Coordination-layer roles (bridge/operator/agent) get full guidance suite.
  // Reduces context injection by ~2000+ tokens for execution-layer agents.
  const EXECUTION_LAYER_ROLES = new Set([
    AGENT_ROLE.EXECUTOR, AGENT_ROLE.RESEARCHER, AGENT_ROLE.REVIEWER, AGENT_ROLE.PLANNER,
  ]);
  const isExecutionLayer = EXECUTION_LAYER_ROLES.has(role);

  for (const fileName of ["BOOTSTRAP.md", "IDENTITY.md", "USER.md", "TOOLS.md"]) {
    await removeWorkspaceFileIf(join(workspaceDir, fileName), (content) => isDefaultOpenClawScaffoldFile(fileName, content));
  }
  if (!isExecutionLayer) {
    await removeWorkspaceFileIf(
      join(workspaceDir, "AGENTS.md"),
      (content) => isDefaultOpenClawScaffoldFile("AGENTS.md", content),
    );
  }

  const soulUpdated = await writeSoulFile(
    join(workspaceDir, "SOUL.md"),
    buildSoulTemplate(agentId, role),
    {
      role,
      force: forcedFiles.has("SOUL.md"),
    },
  );
  const agentsDocUpdated = isExecutionLayer ? false : await writeManagedFile(
    join(workspaceDir, "AGENTS.md"), buildAgentsTemplate(agentId, role, skills), {
      force: forcedFiles.has("AGENTS.md"),
    });
  const buildingMapUpdated = isExecutionLayer ? false : await writeManagedFile(
    join(workspaceDir, "BUILDING-MAP.md"),
    buildBuildingMapTemplate(agentId, role, skills, agentEntries),
    { force: forcedFiles.has("BUILDING-MAP.md") },
  );
  const collaborationGraphUpdated = isExecutionLayer ? false : await writeManagedFile(
    join(workspaceDir, "COLLABORATION-GRAPH.md"),
    buildCollaborationGraphTemplate(agentId, role, effectiveGraph, effectiveLoops),
    { force: forcedFiles.has("COLLABORATION-GRAPH.md") },
  );
  const deliveryUpdated = isExecutionLayer ? false : await writeManagedFile(
    join(workspaceDir, "DELIVERY.md"),
    buildDeliveryTemplate(),
    { force: forcedFiles.has("DELIVERY.md") },
  );
  await unlink(join(workspaceDir, LEGACY_DELIVERY_GUIDANCE_FILE)).catch(() => {});
  const platformGuideUpdated = isExecutionLayer ? false : await writeManagedFile(
    join(workspaceDir, "PLATFORM-GUIDE.md"),
    buildPlatformGuideTemplate(agentId, role, skills, effectiveGraph, effectiveLoops),
    { force: forcedFiles.has("PLATFORM-GUIDE.md") },
  );
  const heartbeatUpdated = await writeManagedFile(
    join(workspaceDir, "HEARTBEAT.md"),
    buildHeartbeatTemplate(),
    {
      legacyContents: [
        "# HEARTBEAT.md\n按 SOUL.md 流程执行。\n",
        "按 SOUL.md 流程执行。\n",
        "按 SOUL.md 流程执行\n",
      ],
      force: forcedFiles.has("HEARTBEAT.md"),
    },
  );
  // Clean up files that execution-layer agents don't need.
  // Framework auto-loads ALL .md from workspace — removing these prevents context bloat.
  if (isExecutionLayer) {
    const EXECUTION_LAYER_CLEANUP = ["AGENTS.md", "BUILDING-MAP.md", "COLLABORATION-GRAPH.md", "DELIVERY.md", "PLATFORM-GUIDE.md"];
    for (const fileName of EXECUTION_LAYER_CLEANUP) {
      await removeWorkspaceFileIf(join(workspaceDir, fileName), (content) => (
        content.includes(MANAGED_BOOTSTRAP_MARKER)
        || isDefaultOpenClawScaffoldFile(fileName, content)
      ));
    }
  }

  return [
    { name: "SOUL.md", updated: soulUpdated },
    { name: "AGENTS.md", updated: agentsDocUpdated },
    { name: "BUILDING-MAP.md", updated: buildingMapUpdated },
    { name: "COLLABORATION-GRAPH.md", updated: collaborationGraphUpdated },
    { name: "DELIVERY.md", updated: deliveryUpdated },
    { name: "PLATFORM-GUIDE.md", updated: platformGuideUpdated },
    { name: "HEARTBEAT.md", updated: heartbeatUpdated },
  ];
}

export async function syncAllRuntimeWorkspaceGuidance(config, logger) {
  const agents = Array.isArray(config?.agents?.list) ? config.agents.list : [];
  const graph = await loadGraph();
  const loops = await listResolvedGraphLoops({ graph });

  const agentEntries = agents.map((agent) => {
    const agentId = typeof agent?.id === "string" ? agent.id.trim() : "";
    if (!agentId) return null;
    const profile = composeEffectiveProfile({
      config,
      agentConfig: agent,
    });
    if (
      profile?.plane !== "runtime"
      || profile?.autoWakeEligible !== true
      || profile?.mainViewVisible !== true
    ) {
      return null;
    }
    const storedBinding = readStoredAgentBinding(agent);
    const role = normalizeAgentRole(storedBinding.roleRef, agentId);
    const skills = composeEffectiveSkillRefs({
      config,
      role,
      configuredSkills: storedBinding.skills?.configured || [],
    });
    return {
      id: agentId,
      role,
      skills,
      workspaceDir: profile.workspace || null,
      gateway: agent.gateway === true,
      ingressSource: typeof agent.ingressSource === "string" ? agent.ingressSource : null,
      specialized: agent.specialized === true,
    };
  }).filter(Boolean);

  for (const entry of agentEntries) {
    try {
      const workspaceDir = entry.workspaceDir || agentWorkspace(entry.id);
      await syncAgentWorkspaceGuidance({
        agentId: entry.id,
        role: entry.role,
        skills: entry.skills,
        workspaceDir,
        graph,
        loops,
        agentEntries,
      });
      await writeIfMissing(
        join(workspaceDir, "agent-card.json"),
        JSON.stringify(buildAgentCard({ agentId: entry.id, role: entry.role, skills: entry.skills }), null, 2),
      );
    } catch (error) {
      logger?.warn?.(`[watchdog] workspace guidance sync failed for ${entry.id}: ${error.message}`);
    }
  }
}

export async function bootstrapAgentWorkspace({
  agentId,
  role,
  skills,
  workspaceDir,
}) {
  await mkdir(workspaceDir, { recursive: true });
  await mkdir(join(workspaceDir, "inbox"), { recursive: true });
  await mkdir(join(workspaceDir, "outbox"), { recursive: true });
  await mkdir(join(workspaceDir, "output"), { recursive: true });

  await writeSoulFile(join(workspaceDir, "SOUL.md"), buildSoulTemplate(agentId, role), { role });
  await writeIfMissing(join(workspaceDir, "HEARTBEAT.md"), buildHeartbeatTemplate());
  await syncAgentWorkspaceGuidance({
    agentId,
    role,
    skills,
    workspaceDir,
  });
  await writeIfMissing(
    join(workspaceDir, "agent-card.json"),
    JSON.stringify(buildAgentCard({ agentId, role, skills }), null, 2),
  );
}
