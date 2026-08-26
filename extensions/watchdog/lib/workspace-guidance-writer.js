import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { atomicWriteFile } from "./state/state-file-utils.js";
import { AGENT_ROLE, normalizeAgentRole } from "./agent/agent-identity.js";
import { isReservedControlLayerAgentId } from "./agent/agent-plane-policy.js";
import { composeEffectiveProfile } from "./effective-profile-composer.js";
import { loadGraph } from "./agent/agent-graph.js";
import { composeAgentCardProjection } from "./agent/agent-card-composer.js";
import { composeEffectiveSkillRefs } from "./agent/agent-binding-policy.js";
import { readStoredAgentBinding } from "./agent/agent-binding-store.js";
import { agentWorkspace } from "./state.js";
import { MANAGED_BOOTSTRAP_MARKER, normalizeManagedDocContent } from "./prompt/managed-doc-markers.js";
import { renderRolePersonaBlock } from "./prompt/role-spec-registry.js";
import {
  buildHeartbeatTemplate,
  buildAgentsTemplate,
  buildBuildingMapTemplate,
  buildCollaborationFallbackTemplate,
  buildCollaborationGraphTemplate,
  buildDeliveryTemplate,
  buildPlatformGuideTemplate,
} from "./prompt/platform-doc-builder.js";
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

// ④role 层载体：IDENTITY.md = renderRolePersonaBlock(role)，系统托管（带 marker）。
// 所有 agent（含执行层）都写；persona 为空时退化为只含 agentId 标题的占位托管文档。
function buildManagedIdentityDoc(agentId, role) {
  const personaBlock = renderRolePersonaBlock(role);
  const body = personaBlock ? `# ${agentId}\n\n${personaBlock}\n` : `# ${agentId}\n`;
  return `${MANAGED_BOOTSTRAP_MARKER}\n${body}`;
}

// ⑤SOUL 层载体：纯用户人格，用户拥有，系统永不重写。bootstrap 时 writeIfMissing 一个
// 不带 marker 的占位 SOUL，之后系统不再触碰它（不在 managed 写清单里）。
function buildUserSoulPlaceholder(agentId) {
  return `# ${agentId}\n\n<Write this agent's custom persona here — you own this file and the platform leaves it untouched.>\n`;
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
  agentEntries = [],
  overwriteCustomGuidance = false,
  overwriteCustomGuidanceFiles = [],
}) {
  const effectiveGraph = graph || await loadGraph();
  const forcedFiles = new Set(
    overwriteCustomGuidance === true
      ? MANAGED_GUIDANCE_FILE_NAMES
      : (Array.isArray(overwriteCustomGuidanceFiles) ? overwriteCustomGuidanceFiles : []),
  );
  await mkdir(workspaceDir, { recursive: true });

  // Execution-layer roles (worker/researcher/planner) get the lean suite
  // (IDENTITY persona + HEARTBEAT); coordination-layer roles get the full guidance suite.
  // ④role lives in IDENTITY.md (managed) for ALL roles; ⑤SOUL is user-owned (never written here).
  const EXECUTION_LAYER_ROLES = new Set([
    AGENT_ROLE.EXECUTOR, AGENT_ROLE.RESEARCHER, AGENT_ROLE.PLANNER,
  ]);
  const isExecutionLayer = EXECUTION_LAYER_ROLES.has(role);

  // IDENTITY.md is now managed (persona carrier); the framework default scaffold for it is
  // replaced by writeManagedFile below, so it stays out of this scaffold-removal sweep.
  for (const fileName of ["BOOTSTRAP.md", "USER.md", "TOOLS.md"]) {
    await removeWorkspaceFileIf(join(workspaceDir, fileName), (content) => isDefaultOpenClawScaffoldFile(fileName, content));
  }
  if (!isExecutionLayer) {
    await removeWorkspaceFileIf(
      join(workspaceDir, "AGENTS.md"),
      (content) => isDefaultOpenClawScaffoldFile("AGENTS.md", content),
    );
  }

  const identityUpdated = await writeManagedFile(
    join(workspaceDir, "IDENTITY.md"),
    buildManagedIdentityDoc(agentId, role),
    {
      legacyPredicates: [(existing) => isDefaultOpenClawScaffoldFile("IDENTITY.md", existing)],
      force: forcedFiles.has("IDENTITY.md"),
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
    buildCollaborationGraphTemplate(agentId, role, effectiveGraph),
    { force: forcedFiles.has("COLLABORATION-GRAPH.md") },
  );
  const deliveryUpdated = isExecutionLayer ? false : await writeManagedFile(
    join(workspaceDir, "DELIVERY.md"),
    buildDeliveryTemplate(),
    { force: forcedFiles.has("DELIVERY.md") },
  );
  await unlink(join(workspaceDir, LEGACY_DELIVERY_GUIDANCE_FILE)).catch(() => {});
  const collaborationFallbackUpdated = isExecutionLayer ? false : await writeManagedFile(
    join(workspaceDir, "COLLABORATION-FALLBACK.md"),
    buildCollaborationFallbackTemplate(),
    { force: forcedFiles.has("COLLABORATION-FALLBACK.md") },
  );
  const platformGuideUpdated = isExecutionLayer ? false : await writeManagedFile(
    join(workspaceDir, "PLATFORM-GUIDE.md"),
    buildPlatformGuideTemplate(agentId, role, skills, effectiveGraph),
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
    { name: "IDENTITY.md", updated: identityUpdated },
    { name: "AGENTS.md", updated: agentsDocUpdated },
    { name: "BUILDING-MAP.md", updated: buildingMapUpdated },
    { name: "COLLABORATION-GRAPH.md", updated: collaborationGraphUpdated },
    { name: "DELIVERY.md", updated: deliveryUpdated },
    { name: "COLLABORATION-FALLBACK.md", updated: collaborationFallbackUpdated },
    { name: "PLATFORM-GUIDE.md", updated: platformGuideUpdated },
    { name: "HEARTBEAT.md", updated: heartbeatUpdated },
  ];
}

export async function syncAllRuntimeWorkspaceGuidance(config, logger) {
  const agents = Array.isArray(config?.agents?.list) ? config.agents.list : [];
  const graph = await loadGraph();

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

  // 心跳驱动的 control-plane 保留 agent（备忘录149 阶段0）：宿主按 heartbeat 配置
  // 唤醒它，但没有心跳契约文件它就是"被叫醒却不知道该干嘛"——viz-master 因此
  // 每轮猜读 HEARTBEAT.md 撞 ENOENT。runtime 平面 seed 全套 guidance 的设计不变，
  // 这里只给"会被心跳叫醒的 control-plane agent"补唤醒契约一个文件。
  for (const agent of agents) {
    const agentId = typeof agent?.id === "string" ? agent.id.trim() : "";
    if (!agentId || !isReservedControlLayerAgentId(agentId)) continue;
    if (!agent?.heartbeat?.every) continue;
    // 优先用配置里的 workspace（~ 展开），缺席才回落 agentWorkspace 的覆盖表/默认——
    // 不依赖 runtimeAgentConfigs 状态，单测可完全离态运行
    const configuredWorkspace = typeof agent.workspace === "string" && agent.workspace.trim()
      ? agent.workspace.trim().replace(/^~(?=\/|$)/, process.env.HOME || "~")
      : null;
    const workspaceDir = configuredWorkspace || agentWorkspace(agentId);
    try {
      await mkdir(workspaceDir, { recursive: true });
      await writeIfMissing(join(workspaceDir, "HEARTBEAT.md"), buildHeartbeatTemplate());
    } catch (error) {
      logger?.warn?.(`[watchdog] heartbeat contract seed failed for ${agentId}: ${error.message}`);
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

  // ⑤SOUL: user-owned placeholder (no marker) — seeded once, then never rewritten by the platform.
  await writeIfMissing(join(workspaceDir, "SOUL.md"), buildUserSoulPlaceholder(agentId));
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
