// Write-side helpers for agent binding store.
// Exports: writeStoredAgentBinding

import {
  normalizeRecord,
  normalizeString,
  uniqueStrings,
  uniqueTools,
} from "../core/normalize.js";
import { composeEffectiveSkillRefs } from "./agent-binding-policy.js";
import {
  hasOwn,
  normalizeCapabilityRecord,
  normalizeStoredAgentModelRef,
  readTopLevelTools,
  sanitizeBindingPolicies,
} from "./agent-binding-store-read.js";
import { composeDefaultCapabilityProjection } from "./agent-capability-policy.js";

function cloneConfiguredCapabilities(value) {
  return normalizeCapabilityRecord(value);
}

function resolveEffectiveCapabilityTools({
  source,
  roleRef,
  configuredSkills,
  configuredCapabilities,
  preferDefaults = false,
}) {
  const explicitTools = uniqueTools(configuredCapabilities.tools || []);
  if (explicitTools.length > 0) {
    return explicitTools;
  }

  if (preferDefaults) {
    const effectiveRole = normalizeString(roleRef)?.toLowerCase()
      || normalizeString(source.role)?.toLowerCase()
      || "agent";
    return uniqueTools(
      composeDefaultCapabilityProjection({
        role: effectiveRole,
        skills: configuredSkills,
      }).tools,
    );
  }

  const existingTopLevelTools = readTopLevelTools(source);
  if (existingTopLevelTools.length > 0) {
    return existingTopLevelTools;
  }

  const effectiveRole = normalizeString(roleRef)?.toLowerCase()
    || normalizeString(source.role)?.toLowerCase()
    || "agent";
  return uniqueTools(
    composeDefaultCapabilityProjection({
      role: effectiveRole,
      skills: configuredSkills,
    }).tools,
  );
}

function buildStoredBindingDocument(binding) {
  const source = normalizeRecord(binding);
  const document = {};
  const roleRef = normalizeString(source.roleRef)?.toLowerCase() || null;
  const workspaceConfigured = normalizeString(source?.workspace?.configured);
  const modelRef = normalizeStoredAgentModelRef(source?.model?.ref);
  const heartbeatEvery = normalizeString(source?.heartbeat?.configuredEvery);
  const configuredSkills = uniqueStrings(source?.skills?.configured || []);
  const configuredCapabilities = cloneConfiguredCapabilities(source?.capabilities?.configured);
  const policies = sanitizeBindingPolicies(source.policies);

  const bindingCapabilities = {};
  if (Array.isArray(configuredCapabilities.inputFormats) && configuredCapabilities.inputFormats.length > 0) {
    bindingCapabilities.inputFormats = configuredCapabilities.inputFormats;
  }
  if (Array.isArray(configuredCapabilities.outputFormats) && configuredCapabilities.outputFormats.length > 0) {
    bindingCapabilities.outputFormats = configuredCapabilities.outputFormats;
  }

  const bindingPolicies = {};
  if (policies.executionPolicy && typeof policies.executionPolicy === "object") {
    bindingPolicies.executionPolicy = policies.executionPolicy;
  }
  // P6-Phase0: 通用 binding policy 容器序列化（与 executionPolicy 对称）。
  if (policies.outputPolicy && typeof policies.outputPolicy === "object") {
    bindingPolicies.outputPolicy = policies.outputPolicy;
  }
  if (policies.inboxPolicy && typeof policies.inboxPolicy === "object") {
    bindingPolicies.inboxPolicy = policies.inboxPolicy;
  }

  if (configuredSkills.length > 0) {
    document.skills = { configured: configuredSkills };
  }
  if (Object.keys(bindingCapabilities).length > 0) {
    document.capabilities = { configured: bindingCapabilities };
  }
  if (Object.keys(bindingPolicies).length > 0) {
    document.policies = bindingPolicies;
  }

  return {
    document,
    roleRef,
    workspaceConfigured,
    modelRef,
    heartbeatEvery,
    configuredSkills,
    configuredCapabilities,
    policies,
  };
}

export function writeStoredAgentBinding(agentConfig, binding, {
  config = null,
} = {}) {
  const source = normalizeRecord(agentConfig);
  const bindingSource = normalizeRecord(binding);
  const rawConfiguredCapabilities = normalizeRecord(bindingSource?.capabilities?.configured);
  const shouldResetToolsToDefaults = hasOwn(bindingSource, "capabilities")
    && Object.keys(rawConfiguredCapabilities).length === 0;
  const {
    document,
    roleRef,
    workspaceConfigured,
    modelRef,
    heartbeatEvery,
    configuredSkills,
    configuredCapabilities,
    policies,
  } = buildStoredBindingDocument(binding);
  const effectiveTools = resolveEffectiveCapabilityTools({
    source,
    roleRef,
    configuredSkills,
    configuredCapabilities,
    preferDefaults: shouldResetToolsToDefaults,
  });
  const effectiveSkills = composeEffectiveSkillRefs({
    config: normalizeRecord(config),
    role: roleRef || normalizeString(source.role)?.toLowerCase() || "agent",
    configuredSkills,
  });

  if (roleRef) {
    source.role = roleRef;
  } else {
    delete source.role;
  }
  if (workspaceConfigured) {
    source.workspace = workspaceConfigured;
  } else {
    delete source.workspace;
  }
  if (modelRef) {
    source.model = { primary: modelRef };
  } else {
    delete source.model;
  }
  if (heartbeatEvery) {
    source.heartbeat = { every: heartbeatEvery };
  } else {
    delete source.heartbeat;
  }
  if (effectiveSkills.length > 0) {
    source.skills = effectiveSkills;
  } else {
    delete source.skills;
  }

  if (effectiveTools.length > 0) {
    source.tools = { allow: effectiveTools };
  } else {
    delete source.tools;
  }

  const routerHandlerId = normalizeString(configuredCapabilities.routerHandlerId);
  if (routerHandlerId) {
    source.routerHandlerId = routerHandlerId;
  } else {
    delete source.routerHandlerId;
  }

  const outboxCommitKinds = uniqueStrings(configuredCapabilities.outboxCommitKinds || []);
  if (outboxCommitKinds.length > 0) {
    source.outboxCommitKinds = outboxCommitKinds;
  } else {
    delete source.outboxCommitKinds;
  }

  if (hasOwn(policies, "gateway")) {
    source.gateway = policies.gateway === true;
  } else {
    delete source.gateway;
  }
  if (hasOwn(policies, "protected")) {
    source.protected = policies.protected === true;
  } else {
    delete source.protected;
  }
  if (hasOwn(policies, "specialized")) {
    source.specialized = policies.specialized === true;
  } else {
    delete source.specialized;
  }
  if (hasOwn(policies, "ingressSource")) {
    source.ingressSource = policies.ingressSource;
  } else {
    delete source.ingressSource;
  }

  if (configuredSkills.length === 0 && effectiveSkills.length > 0 && !document.skills) {
    document.skills = { configured: [] };
  }

  if (Object.keys(document).length > 0) {
    source.binding = document;
  } else {
    delete source.binding;
  }
  delete source.source;

  return source;
}
