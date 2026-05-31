import { join } from "node:path";

import { resolveDefaultHeartbeatEvery } from "./agent/agent-admin-defaults.js";
import { composeDefaultSkillRefs } from "./agent/agent-binding-policy.js";
import { resolveActorPlanePolicy } from "./agent/agent-plane-policy.js";
import {
  normalizeStoredAgentModelRef,
  readStoredAgentBinding,
} from "./agent/agent-binding-store.js";
import { composeDefaultCapabilityProjection } from "./agent/agent-capability-policy.js";
import { composeAgentCardBase } from "./agent/agent-card-composer.js";
import { normalizeAgentRole } from "./agent/agent-identity.js";
import {
  getDefaultExecutionPolicy,
  mergeExecutionPolicy,
} from "./execution-policy-defaults.js";
import { normalizeRecord, normalizeString, uniqueStrings, uniqueTools } from "./core/normalize.js";
import { readJsonFile } from "./state-file-utils.js";
import { defaultAgentWorkspace } from "./state-agent-helpers.js";
import { HOME, OC } from "./state-paths.js";

function normalizeAgentModel(model) {
  return normalizeStoredAgentModelRef(model) || "unknown";
}

export function expandHomePath(filePath) {
  const value = normalizeString(filePath);
  if (!value) return null;
  return value.replace(/^~(?=\/|$)/, HOME);
}

export async function loadAgentCardProjection(agentConfig) {
  const storedBinding = readStoredAgentBinding(agentConfig);
  const agentId = normalizeString(agentConfig?.id) || storedBinding.agentId || "unknown";
  const workspaceDir = expandHomePath(agentConfig?.workspace)
    || expandHomePath(storedBinding.workspace?.configured)
    || defaultAgentWorkspace(agentId);
  const paths = [
    join(workspaceDir, "agent-card.json"),
    join(OC, "workspaces", "_configs", `${agentId}-agent-card.json`),
  ];
  for (const filePath of paths) {
    const card = await readJsonFile(filePath);
    if (card && typeof card === "object") return card;
  }
  return null;
}

export function composeAgentBinding({
  config,
  agentConfig,
  card = null,
  role = null,
}) {
  const storedBinding = readStoredAgentBinding(agentConfig);
  const agentId = storedBinding.agentId || normalizeString(agentConfig?.id) || "unknown";
  const normalizedRole = normalizeAgentRole(
    normalizeString(role) || normalizeString(storedBinding.roleRef) || normalizeString(card?.role),
    agentId,
  );
  const configuredCapabilities = normalizeRecord(storedBinding.capabilities?.configured);
  const projectedCapabilities = normalizeRecord(card?.capabilities);
  const configuredHeartbeatEvery = normalizeString(storedBinding.heartbeat?.configuredEvery);
  const effectiveHeartbeatEvery = configuredHeartbeatEvery || resolveDefaultHeartbeatEvery(config);
  const defaultSkills = composeDefaultSkillRefs(config, normalizedRole);
  const configuredSkills = uniqueStrings(storedBinding.skills?.configured || []);
  const effectiveSkills = uniqueStrings([...defaultSkills, ...configuredSkills]);
  const defaultCapabilities = composeDefaultCapabilityProjection({
    role: normalizedRole,
    skills: effectiveSkills,
  });

  return {
    agentId,
    roleRef: normalizedRole,
    workspace: {
      configured: expandHomePath(agentConfig?.workspace) || expandHomePath(storedBinding.workspace?.configured),
      effective: expandHomePath(agentConfig?.workspace)
        || expandHomePath(storedBinding.workspace?.configured)
        || defaultAgentWorkspace(agentId),
    },
    model: {
      ref: normalizeAgentModel(storedBinding.model?.ref),
    },
    heartbeat: {
      configuredEvery: configuredHeartbeatEvery,
      effectiveEvery: effectiveHeartbeatEvery,
    },
    skills: {
      configured: configuredSkills,
      defaults: defaultSkills,
      effective: effectiveSkills,
    },
    capabilities: {
      defaults: defaultCapabilities,
      configured: configuredCapabilities,
      projected: projectedCapabilities,
    },
    policies: {
      gateway: storedBinding.policies?.gateway === true,
      protected: storedBinding.policies?.protected === true,
      ingressSource: normalizeString(storedBinding.policies?.ingressSource)?.toLowerCase() || null,
      specialized: storedBinding.policies?.specialized === true,
      configuredExecutionPolicy: storedBinding.policies?.executionPolicy || null,
      effectiveExecutionPolicy: mergeExecutionPolicy(
        getDefaultExecutionPolicy(normalizedRole),
        storedBinding.policies?.executionPolicy,
      ),
      // P6-Phase0: 通用 binding policy 投影（无默认合并——纯配置，Phase1 才接消费者）。
      outputPolicy: storedBinding.policies?.outputPolicy || null,
      inboxPolicy: storedBinding.policies?.inboxPolicy || null,
    },
  };
}

export function composeEffectiveProfile({
  config,
  agentConfig,
  card = null,
  role = null,
}) {
  const binding = composeAgentBinding({
    config,
    agentConfig,
    card,
    role,
  });
  const baseCard = composeAgentCardBase({
    agentId: binding.agentId,
    role: binding.roleRef,
  });
  const baseCapabilities = normalizeRecord(binding.capabilities?.defaults);
  const tools = uniqueTools(
    binding.capabilities?.configured?.tools
    || agentConfig?.tools?.allow
    || binding.capabilities?.projected?.tools
    || baseCapabilities.tools,
  );
  const outputFormats = uniqueStrings(
    binding.capabilities?.configured?.outputFormats
    || binding.capabilities?.projected?.outputFormats
    || baseCapabilities.outputFormats,
  );
  const inputFormats = uniqueStrings(
    binding.capabilities?.configured?.inputFormats
    || binding.capabilities?.projected?.inputFormats
    || baseCapabilities.inputFormats,
  );
  const outboxCommitKinds = uniqueStrings(
    Array.isArray(binding.capabilities?.configured?.outboxCommitKinds)
      ? binding.capabilities.configured.outboxCommitKinds
      : (binding.capabilities?.projected?.outboxCommitKinds || baseCapabilities.outboxCommitKinds),
  );
  const routerHandlerId = normalizeString(binding.capabilities?.configured?.routerHandlerId)
    || normalizeString(binding.capabilities?.projected?.routerHandlerId)
    || normalizeString(baseCapabilities.routerHandlerId);
  const capabilities = {
    ...baseCapabilities,
    ...normalizeRecord(binding.capabilities?.projected),
    ...normalizeRecord(binding.capabilities?.configured),
    ...(tools.length ? { tools } : {}),
    ...(inputFormats.length ? { inputFormats } : {}),
    ...(outputFormats.length ? { outputFormats } : {}),
    ...(outboxCommitKinds.length ? { outboxCommitKinds } : {}),
    ...(routerHandlerId ? { routerHandlerId } : {}),
    ...(binding.skills?.effective?.length ? { skills: binding.skills.effective } : {}),
  };
  const actorPolicy = resolveActorPlanePolicy({
    agentId: binding.agentId,
    configuredPlane: agentConfig?.plane || null,
    configuredMainViewVisible: typeof agentConfig?.mainViewVisible === "boolean"
      ? agentConfig.mainViewVisible
      : null,
    configuredFormalTimelineVisible: typeof agentConfig?.formalTimelineVisible === "boolean"
      ? agentConfig.formalTimelineVisible
      : null,
    configuredAutoWakeEligible: typeof agentConfig?.autoWakeEligible === "boolean"
      ? agentConfig.autoWakeEligible
      : null,
    role: binding.roleRef,
    gateway: binding.policies?.gateway === true,
    ingressSource: binding.policies?.ingressSource || null,
  });

  return {
    id: binding.agentId,
    name: normalizeString(card?.name) || baseCard.name,
    workspace: binding.workspace?.configured,
    model: binding.model?.ref,
    heartbeatEvery: binding.heartbeat?.effectiveEvery,
    configuredHeartbeatEvery: binding.heartbeat?.configuredEvery,
    effectiveHeartbeatEvery: binding.heartbeat?.effectiveEvery,
    role: binding.roleRef,
    description: normalizeString(card?.description) || baseCard.description,
    constraints: card?.constraints && typeof card.constraints === "object" ? card.constraints : baseCard.constraints,
    capabilities: Object.keys(capabilities).length ? capabilities : undefined,
    configuredSkills: binding.skills?.configured || [],
    defaultSkills: binding.skills?.defaults || [],
    effectiveSkills: binding.skills?.effective || [],
    gateway: binding.policies?.gateway === true,
    protected: binding.policies?.protected === true,
    ingressSource: binding.policies?.ingressSource || null,
    specialized: binding.policies?.specialized === true,
    plane: actorPolicy.plane,
    mainViewVisible: actorPolicy.mainViewVisible,
    formalTimelineVisible: actorPolicy.formalTimelineVisible,
    autoWakeEligible: actorPolicy.autoWakeEligible,
    policies: binding.policies,
    binding,
  };
}

export function composeRuntimeCapabilityProfile({
  agentId,
  runtimeConfig = null,
  card = null,
}) {
  const runtimeProfile = normalizeRecord(runtimeConfig);
  const storedBinding = readStoredAgentBinding(runtimeConfig);
  const normalizedAgentId = normalizeString(agentId) || storedBinding.agentId || "unknown";
  const role = normalizeAgentRole(
    normalizeString(runtimeProfile.role)
      || normalizeString(storedBinding.roleRef)
      || normalizeString(card?.role),
    normalizedAgentId,
  );
  const configuredCapabilities = normalizeRecord(
    runtimeProfile.capabilities || storedBinding.capabilities?.configured,
  );
  const projectedCapabilities = normalizeRecord(card?.capabilities);
  const baseCapabilities = composeDefaultCapabilityProjection({
    role,
    skills: uniqueStrings(projectedCapabilities.skills || runtimeProfile.skills || storedBinding.skills?.configured || []),
  });

  return {
    agentId: normalizedAgentId,
    role,
    routerHandlerId: normalizeString(configuredCapabilities.routerHandlerId)
      || normalizeString(projectedCapabilities.routerHandlerId)
      || normalizeString(baseCapabilities.routerHandlerId)
      || null,
    outboxCommitKinds: uniqueStrings(
      Array.isArray(configuredCapabilities.outboxCommitKinds)
        ? configuredCapabilities.outboxCommitKinds
        : (projectedCapabilities.outboxCommitKinds || baseCapabilities.outboxCommitKinds || []),
    ),
  };
}
