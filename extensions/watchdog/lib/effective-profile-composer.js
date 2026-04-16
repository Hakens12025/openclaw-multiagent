import { join } from "node:path";

import { resolveDefaultHeartbeatEvery } from "./agent/agent-admin-defaults.js";
import { composeDefaultSkillRefs } from "./agent/agent-binding-policy.js";
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
import { HOME, OC } from "./state.js";

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
    || join(OC, `workspaces/${agentId}`);
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
      configured: expandHomePath(storedBinding.workspace?.configured),
      effective: expandHomePath(storedBinding.workspace?.configured) || join(OC, `workspaces/${agentId}`),
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
    binding.capabilities?.projected?.tools
    || binding.capabilities?.configured?.tools
    || agentConfig?.tools?.allow
    || baseCapabilities.tools,
  );
  const outputFormats = uniqueStrings(
    binding.capabilities?.projected?.outputFormats
    || binding.capabilities?.configured?.outputFormats
    || baseCapabilities.outputFormats,
  );
  const inputFormats = uniqueStrings(
    binding.capabilities?.projected?.inputFormats
    || binding.capabilities?.configured?.inputFormats
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
