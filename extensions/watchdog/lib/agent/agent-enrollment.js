// lib/agent-enrollment.js — agent join & enrollment operations

import { basename, join, resolve } from "node:path";

import { readJsonFile } from "../state-file-utils.js";
import {
  resolveDefaultHeartbeatEvery,
  resolveDefaultModel,
} from "./agent-admin-defaults.js";
import { syncExistingAgentWorkspaceProfile } from "./agent-admin-context.js";
import {
  loadConfig,
  normalizeSkillPayload,
  runAgentAdminWrite,
  saveConfig,
} from "./agent-admin-store.js";
import {
  normalizeStoredAgentModelRef,
  readStoredAgentBinding,
  writeStoredAgentBinding,
} from "./agent-binding-store.js";
import { isSupportedAgentRole, normalizeAgentRole } from "./agent-identity.js";
import {
  expandHomePath,
  loadAgentCardProjection,
} from "../effective-profile-composer.js";
import { normalizeBoolean, normalizeString, uniqueStrings } from "../core/normalize.js";
import { OC } from "../state-paths.js";

import {
  compactHomePath,
  summarizeLocalAgentDiscovery,
} from "./agent-enrollment-discovery.js";

function applyOptionalPolicyField(target, key, value) {
  if (value === undefined) return;
  if (value === null) {
    delete target[key];
    return;
  }
  target[key] = value;
}

async function ensureConfiguredAgentEnrollment({
  config,
  agent,
  agentId,
  payload,
}) {
  const storedBinding = readStoredAgentBinding(agent);
  const card = await loadAgentCardProjection(agent);
  const role = normalizeAgentRole(
    payload.role || storedBinding.roleRef || agent?.role || card?.role,
    agentId,
  );
  if (!isSupportedAgentRole(role)) {
    throw new Error(`unsupported role: ${payload.role || storedBinding.roleRef || agent?.role || card?.role || role}`);
  }
  const workspaceConfigured = compactHomePath(
    expandHomePath(payload.workspacePath || storedBinding.workspace?.configured || agent?.workspace)
    || join(OC, "workspaces", agentId),
  );
  const modelRef = normalizeStoredAgentModelRef(storedBinding.model?.ref || agent?.model)
    || resolveDefaultModel(config);
  const heartbeatEvery = normalizeString(storedBinding.heartbeat?.configuredEvery || agent?.heartbeat?.every)
    || resolveDefaultHeartbeatEvery(config);
  const policies = {
    ...(storedBinding.policies && typeof storedBinding.policies === "object" ? storedBinding.policies : {}),
  };
  applyOptionalPolicyField(policies, "gateway", payload.gateway);
  applyOptionalPolicyField(policies, "protected", payload.protected);
  applyOptionalPolicyField(policies, "specialized", payload.specialized);
  applyOptionalPolicyField(
    policies,
    "ingressSource",
    payload.ingressSource === null ? null : (normalizeString(payload.ingressSource)?.toLowerCase() || undefined),
  );

  writeStoredAgentBinding(agent, {
    agentId,
    roleRef: role,
    workspace: { configured: workspaceConfigured },
    model: modelRef ? { ref: modelRef } : {},
    heartbeat: heartbeatEvery ? { configuredEvery: heartbeatEvery } : {},
    skills: {
      configured: payload.skills === undefined
        ? uniqueStrings(storedBinding.skills?.configured || [])
        : normalizeSkillPayload(payload.skills),
    },
    policies,
  });
  await saveConfig(config);
  await syncExistingAgentWorkspaceProfile({
    config,
    agentId,
    agent,
    role,
  });

  return { agentId, created: false };
}

async function registerWorkspaceOnlyAgent({
  config,
  payload,
}) {
  const workspaceDir = resolve(
    expandHomePath(payload.workspacePath) || payload.workspacePath || "",
  );
  if (!workspaceDir) {
    throw new Error("missing workspacePath for local-workspace candidate");
  }

  const card = await readJsonFile(join(workspaceDir, "agent-card.json"));
  const agentId = normalizeString(payload.agentId || card?.id || basename(workspaceDir));
  if (!agentId) {
    throw new Error("unable to resolve local agent id");
  }
  if (config.agents.list.some((entry) => entry?.id === agentId)) {
    throw new Error(`agent already exists: ${agentId}`);
  }

  const role = normalizeAgentRole(payload.role || card?.role, agentId);
  if (!isSupportedAgentRole(role)) {
    throw new Error(`unsupported role: ${payload.role || card?.role || role}`);
  }
  const modelRef = resolveDefaultModel(config);
  const heartbeatEvery = resolveDefaultHeartbeatEvery(config);
  const newAgent = { id: agentId };
  writeStoredAgentBinding(newAgent, {
    agentId,
    roleRef: role,
    workspace: { configured: compactHomePath(workspaceDir) },
    model: modelRef ? { ref: modelRef } : {},
    heartbeat: heartbeatEvery ? { configuredEvery: heartbeatEvery } : {},
    skills: {
      configured: normalizeSkillPayload(payload.skills),
    },
  });
  config.agents.list.push(newAgent);
  await saveConfig(config);
  await syncExistingAgentWorkspaceProfile({
    config,
    agentId,
    agent: newAgent,
    role,
  });
  return { agentId, created: true };
}

export async function joinLocalAgentDefinition({
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
    const existing = agentId
      ? config.agents.list.find((entry) => entry?.id === agentId) || null
      : null;

    const normalizedPayload = {
      ...payload,
      agentId,
      role: normalizeString(payload?.role) || undefined,
      ingressSource: payload?.ingressSource === "default"
        ? null
        : (normalizeString(payload?.ingressSource) || undefined),
      gateway: payload?.gateway == null ? undefined : normalizeBoolean(payload.gateway),
      protected: payload?.protected == null ? undefined : normalizeBoolean(payload.protected),
      specialized: payload?.specialized == null ? undefined : normalizeBoolean(payload.specialized),
    };

    const result = existing
      ? await ensureConfiguredAgentEnrollment({
          config,
          agent: existing,
          agentId,
          payload: normalizedPayload,
        })
      : await registerWorkspaceOnlyAgent({
          config,
          payload: normalizedPayload,
        });

    const discovery = await summarizeLocalAgentDiscovery();
    const enrolled = discovery.agents.find((entry) => entry.id === result.agentId) || null;
    logger?.info?.(
      `[watchdog] local agent enrolled: ${result.agentId} `
      + `(created=${result.created ? "yes" : "no"}, status=${enrolled?.status || "unknown"})`,
    );
    onAlert?.({
      type: "agent_enrolled",
      agentId: result.agentId,
      created: result.created === true,
      status: enrolled?.status || null,
      ts: Date.now(),
    });

    return {
      ok: true,
      action: "join",
      agentId: result.agentId,
      created: result.created === true,
      agent: enrolled,
      discovery,
    };
  });
}
