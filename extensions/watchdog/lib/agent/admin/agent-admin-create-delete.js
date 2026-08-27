import { rm } from "node:fs/promises";

import { OC, agentWorkspace } from "../../state.js";
import { composeDefaultSkillRefs } from "../agent-binding-policy.js";
import {
  readStoredAgentBinding,
  writeStoredAgentBinding,
} from "../agent-binding-store.js";
import {
  buildAgentCard,
  bootstrapAgentWorkspace,
  syncAllRuntimeWorkspaceGuidance,
} from "../../workspace-guidance-writer.js";
import {
  isProtectedAgentId,
  isSupportedAgentRole,
} from "./agent-admin-context.js";
import { normalizeAgentRole, registerRuntimeAgents } from "../agent-identity.js";
import { getCapabilityPreset } from "../../security/capability-preset-registry.js";
import { listExposedToolIntents } from "../../system-action/collaboration-intent-policy.js";
import { isActionAllowedForRole } from "../../system-action/system-action-role-policy.js";
import {
  resolveDefaultModel,
} from "./agent-admin-defaults.js";
import { normalizeString } from "../../core/normalize.js";
import {
  loadConfig,
  loadExistingAgentConfig,
  runAgentAdminWrite,
  saveConfig,
} from "./agent-admin-store.js";
import {
  LOCAL_WORKSPACE_SOURCE,
  findDiscoveredAgentEntry,
  summarizeLocalAgentDiscovery,
} from "../agent-enrollment-discovery.js";
import { setAgentCard, deleteAgentCard } from "../../store/agent-card-store.js";
import { pruneGraphToAgentIds } from "../agent-graph-mutations.js";
import { EVENT_TYPE } from "../../core/event-types.js";
import { pruneGroupSessionsForTopology } from "../group-session-store.js";
import { assertRuntimeAgentIdIsNotReserved } from "../agent-plane-policy.js";

// agent 删除的拓扑级联：图边 + GroupSession 两条腿。
// GroupSession 走 groupIds:null（组维不参与判定）——group 没有独立注册表，成员失效才是
// 删 agent 要级联的东西；不剪则被删 agent 会永久留在组的成员态里。
export async function pruneTopologyArtifactsForKnownAgents(agentIds, { writer = "unknown", logger = console } = {}) {
  const graphCleanup = await pruneGraphToAgentIds(agentIds, { writer, logger });
  const groupSessionCleanup = await pruneGroupSessionsForTopology({
    agentIds,
    groupIds: null,
  });

  return {
    changed: graphCleanup.changed || groupSessionCleanup.changed,
    removedEdges: graphCleanup.removedEdges || [],
    removedGroupSessions: groupSessionCleanup.removed || [],
  };
}

export function listConfiguredAgentIds(config) {
  return (Array.isArray(config?.agents?.list) ? config.agents.list : [])
    .map((item) => normalizeString(item?.id))
    .filter(Boolean);
}

async function findWorkspaceOnlyResidue(agentId) {
  const discovery = await summarizeLocalAgentDiscovery({ includeLocalWorkspace: true });
  const entry = findDiscoveredAgentEntry(discovery, agentId);
  return entry?.source === LOCAL_WORKSPACE_SOURCE ? entry : null;
}

async function removeAgentDefinition({
  agentId,
  logger = null,
  onAlert = null,
  deleteWorkspace = false,
  eventType = "agent_deleted",
}) {
  const normalizedAgentId = normalizeString(agentId);
  if (!normalizedAgentId) {
    throw new Error("missing agentId");
  }

  const config = await loadConfig();
  const idx = config.agents.list.findIndex((item) => item?.id === normalizedAgentId);
  const configuredAgent = idx !== -1;
  if (configuredAgent && isProtectedAgentId(normalizedAgentId)) {
    throw new Error(`cannot delete protected agent: ${normalizedAgentId}`);
  }

  let workspaceOnlyResidue = null;
  if (!configuredAgent && deleteWorkspace) {
    workspaceOnlyResidue = await findWorkspaceOnlyResidue(normalizedAgentId);
  }
  if (!configuredAgent && !workspaceOnlyResidue) {
    throw new Error(`agent not found: ${normalizedAgentId}`);
  }

  if (configuredAgent) {
    config.agents.list.splice(idx, 1);
    await saveConfig(config);
    deleteAgentCard(normalizedAgentId);
    await syncAllRuntimeWorkspaceGuidance(config, logger);
  }

  const remainingAgentIds = listConfiguredAgentIds(config);
  const topologyCleanup = await pruneTopologyArtifactsForKnownAgents(remainingAgentIds, {
    writer: `agent-delete:${normalizedAgentId}`,
    logger,
  });

  let workspaceDeleted = false;
  if (deleteWorkspace) {
    const workspaceDir = normalizeString(workspaceOnlyResidue?.workspacePath)
      || agentWorkspace(normalizedAgentId);
    try {
      await rm(workspaceDir, { recursive: true, force: false });
      workspaceDeleted = true;
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
    }
  }

  if (topologyCleanup.changed) {
    onAlert?.({
      type: EVENT_TYPE.GRAPH_UPDATED,
      action: deleteWorkspace ? "agent_hard_delete_pruned_topology" : "agent_delete_pruned_topology",
      agentId: normalizedAgentId,
      removedEdges: topologyCleanup.removedEdges,
      removedGroupSessions: topologyCleanup.removedGroupSessions.map((session) => session.id),
      ts: Date.now(),
    });
  }

  logger?.info?.(
    `[watchdog] ${configuredAgent ? "agent" : "local workspace residue"} `
    + `${deleteWorkspace ? "hard-deleted" : "deleted"}: ${normalizedAgentId}`,
  );
  onAlert?.({
    type: eventType,
    agentId: normalizedAgentId,
    workspaceDeleted,
    configuredDeleted: configuredAgent,
    ts: Date.now(),
  });

  return {
    ok: true,
    id: normalizedAgentId,
    topologyCleanup,
    workspaceDeleted,
    configuredDeleted: configuredAgent,
  };
}

export async function createAgentDefinition({
  id,
  model = null,
  role = null,
  logger = null,
  onAlert = null,
}) {
  return runAgentAdminWrite(async () => {
    const normalizedId = normalizeString(id);
    if (!normalizedId) {
      throw new Error("missing id");
    }
    assertRuntimeAgentIdIsNotReserved(normalizedId);

    const config = await loadConfig();
    if (config.agents.list.find((item) => item?.id === normalizedId)) {
      throw new Error(`agent already exists: ${normalizedId}`);
    }

    const normalizedRole = normalizeAgentRole(role, normalizedId);
    if (!isSupportedAgentRole(normalizedRole)) {
      throw new Error(`unsupported role: ${role}`);
    }
    const defaultModel = resolveDefaultModel(config);
    const primaryModel = normalizeString(model) || defaultModel;
    if (!primaryModel) {
      throw new Error("missing model and no agent default model configured");
    }

    const configuredSkills = [];
    const effectiveSkills = composeDefaultSkillRefs(config, normalizedRole);
    // 协作 FC 工具是 optional:true——框架只给 tools.allow 点名的 agent 物化。
    // 建约时不写 tools,新 agent 就生来一个协作工具都没有,只能退回 [ACTION] 文本路。
    // 工具名从授权单源(collaboration-intent-policy)按角色派生,不在本文件抄第二份;
    // 能力预设的本地工具(read/write/ls/…)与它取并集。
    const configuredTools = [
      ...getCapabilityPreset(normalizedRole).tools,
      ...listExposedToolIntents().filter((intent) => isActionAllowedForRole(normalizedRole, intent)),
    ];
    const workspaceDir = agentWorkspace(normalizedId);
    const newAgent = { id: normalizedId };
    writeStoredAgentBinding(newAgent, {
      agentId: normalizedId,
      roleRef: normalizedRole,
      workspace: {
        configured: workspaceDir.replace(OC, "~/.openclaw"),
      },
      model: {
        ref: primaryModel,
      },
      skills: {
        configured: configuredSkills,
      },
      tools: configuredTools,
    });

    await bootstrapAgentWorkspace({
      agentId: normalizedId,
      role: normalizedRole,
      skills: effectiveSkills,
      workspaceDir,
    });
    setAgentCard(normalizedId, buildAgentCard({
      agentId: normalizedId,
      role: normalizedRole,
      skills: effectiveSkills,
    }), "agent-admin/create");

    config.agents.list.push(newAgent);
    await saveConfig(config);
    logger?.info?.(
      `[watchdog] agent created: ${normalizedId} `
      + `(role=${normalizedRole}, configured=[${configuredSkills.join(",")}], effective=[${effectiveSkills.join(",")}])`,
    );
    onAlert?.({ type: "agent_created", agentId: normalizedId, ts: Date.now() });

    return {
      ok: true,
      id: normalizedId,
      role: normalizedRole,
      model: primaryModel,
      configuredSkills,
      effectiveSkills,
      skills: effectiveSkills,
      workspace: newAgent.workspace,
    };
  });
}

export async function deleteAgentDefinition({
  agentId,
  logger = null,
  onAlert = null,
}) {
  return runAgentAdminWrite(async () => removeAgentDefinition({
    agentId,
    logger,
    onAlert,
  }));
}

export async function hardDeleteAgentDefinition({
  agentId,
  logger = null,
  onAlert = null,
}) {
  return runAgentAdminWrite(async () => removeAgentDefinition({
    agentId,
    logger,
    onAlert,
    deleteWorkspace: true,
    eventType: "agent_hard_deleted",
  }));
}
