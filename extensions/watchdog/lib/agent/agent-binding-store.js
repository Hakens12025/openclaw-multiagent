import {
  normalizeRecord,
  normalizeString,
  uniqueStrings,
  uniqueTools,
} from "../core/normalize.js";

const EXEC_POLICY_BOOLEANS = ["planRequired", "draftLifecycle", "autoFollowUp", "noDirectIntake"];
const EXEC_POLICY_NUMBERS = ["autoPromoteTimeout"];
const EXEC_POLICY_ENUMS = { sessionCleanup: ["immediate", "deferred"] };

function hasOwn(record, key) {
  return Object.prototype.hasOwnProperty.call(record || {}, key);
}

function readOptionalBoolean(record, key) {
  return hasOwn(record, key)
    ? record[key] === true
    : null;
}

function readTopLevelSkillRefs(source) {
  if (Array.isArray(source.skills)) {
    return uniqueStrings(source.skills);
  }
  const nestedSkills = normalizeRecord(source.skills);
  if (Array.isArray(nestedSkills.configured)) {
    return uniqueStrings(nestedSkills.configured);
  }
  return [];
}

function readTopLevelTools(source) {
  if (Array.isArray(source.tools)) {
    return uniqueTools(source.tools);
  }
  const tools = normalizeRecord(source.tools);
  if (Array.isArray(tools.allow)) {
    return uniqueTools(tools.allow);
  }
  return [];
}

function readTopLevelHeartbeatEvery(source) {
  const heartbeat = normalizeRecord(source.heartbeat);
  return normalizeString(heartbeat.every)
    || normalizeString(heartbeat.configuredEvery)
    || null;
}

function readTopLevelPolicies(source) {
  const policies = {};

  if (hasOwn(source, "gateway")) {
    policies.gateway = source.gateway === true;
  }
  if (hasOwn(source, "protected")) {
    policies.protected = source.protected === true;
  }
  if (hasOwn(source, "specialized")) {
    policies.specialized = source.specialized === true;
  }

  const ingressSource = normalizeString(source.ingressSource)?.toLowerCase() || null;
  if (ingressSource) {
    policies.ingressSource = ingressSource;
  }

  if (source.executionPolicy && typeof source.executionPolicy === "object") {
    policies.executionPolicy = source.executionPolicy;
  }

  return policies;
}

function readTopLevelCapabilities(source) {
  const configuredCapabilities = {};
  const toolOverrides = readTopLevelTools(source);
  const topLevelCapabilities = normalizeRecord(source.capabilities);
  const topLevelConfiguredCapabilities = normalizeRecord(topLevelCapabilities.configured);

  if (toolOverrides.length > 0) {
    configuredCapabilities.tools = toolOverrides;
  }

  const inputFormats = uniqueStrings(
    topLevelConfiguredCapabilities.inputFormats
    || topLevelCapabilities.inputFormats
    || source.inputFormats
    || [],
  );
  if (inputFormats.length > 0) {
    configuredCapabilities.inputFormats = inputFormats;
  }

  const outputFormats = uniqueStrings(
    topLevelConfiguredCapabilities.outputFormats
    || topLevelCapabilities.outputFormats
    || source.outputFormats
    || [],
  );
  if (outputFormats.length > 0) {
    configuredCapabilities.outputFormats = outputFormats;
  }

  const routerHandlerId = normalizeString(source.routerHandlerId)
    || normalizeString(topLevelConfiguredCapabilities.routerHandlerId)
    || normalizeString(topLevelCapabilities.routerHandlerId);
  if (routerHandlerId) {
    configuredCapabilities.routerHandlerId = routerHandlerId;
  }

  const outboxCommitKinds = uniqueStrings(
    source.outboxCommitKinds
    || topLevelConfiguredCapabilities.outboxCommitKinds
    || topLevelCapabilities.outboxCommitKinds
    || [],
  );
  if (outboxCommitKinds.length > 0) {
    configuredCapabilities.outboxCommitKinds = outboxCommitKinds;
  }

  return normalizeCapabilityRecord(configuredCapabilities);
}

export function normalizeStoredAgentModelRef(value) {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  if (value && typeof value === "object") {
    return normalizeString(value.ref)
      || normalizeString(value.primary)
      || normalizeString(value.default)
      || null;
  }
  return null;
}

function normalizeCapabilityRecord(value) {
  const source = normalizeRecord(value);
  const normalized = { ...source };

  if (hasOwn(source, "tools")) {
    normalized.tools = uniqueTools(source.tools);
  }
  if (hasOwn(source, "inputFormats")) {
    normalized.inputFormats = uniqueStrings(source.inputFormats);
  }
  if (hasOwn(source, "outputFormats")) {
    normalized.outputFormats = uniqueStrings(source.outputFormats);
  }
  if (hasOwn(source, "outboxCommitKinds")) {
    normalized.outboxCommitKinds = uniqueStrings(source.outboxCommitKinds);
  }
  if (hasOwn(source, "routerHandlerId")) {
    const routerHandlerId = normalizeString(source.routerHandlerId);
    if (routerHandlerId) {
      normalized.routerHandlerId = routerHandlerId;
    } else {
      delete normalized.routerHandlerId;
    }
  }

  return normalized;
}

function sanitizeBindingPolicies(value) {
  const source = normalizeRecord(value);
  const policies = {};

  const gateway = readOptionalBoolean(source, "gateway");
  if (gateway !== null) {
    policies.gateway = gateway;
  }

  const protectedAgent = readOptionalBoolean(source, "protected");
  if (protectedAgent !== null) {
    policies.protected = protectedAgent;
  }

  const specialized = readOptionalBoolean(source, "specialized");
  if (specialized !== null) {
    policies.specialized = specialized;
  }

  const ingressSource = normalizeString(source.ingressSource)?.toLowerCase() || null;
  if (ingressSource) {
    policies.ingressSource = ingressSource;
  }

  const executionPolicy = normalizeRecord(source.executionPolicy);
  if (executionPolicy && Object.keys(executionPolicy).length > 0) {
    const ep = {};
    for (const key of EXEC_POLICY_BOOLEANS) {
      if (typeof executionPolicy[key] === "boolean") {
        ep[key] = executionPolicy[key];
      }
    }
    for (const key of EXEC_POLICY_NUMBERS) {
      if (Number.isFinite(executionPolicy[key])) {
        ep[key] = executionPolicy[key];
      }
    }
    for (const [key, allowed] of Object.entries(EXEC_POLICY_ENUMS)) {
      if (allowed.includes(executionPolicy[key])) {
        ep[key] = executionPolicy[key];
      }
    }
    if (Object.keys(ep).length > 0) {
      policies.executionPolicy = ep;
    }
  }

  return policies;
}

export function readStoredAgentBinding(agentConfig) {
  const source = normalizeRecord(agentConfig);
  const binding = normalizeRecord(source.binding);
  const topLevelCapabilities = readTopLevelCapabilities(source);
  const nestedCapabilities = normalizeCapabilityRecord(binding?.capabilities?.configured);
  const bindingCapabilities = normalizeCapabilityRecord({
    ...nestedCapabilities,
    ...topLevelCapabilities,
  });
  const policies = sanitizeBindingPolicies({
    ...normalizeRecord(binding?.policies),
    ...readTopLevelPolicies(source),
  });
  const nestedSkills = hasOwn(normalizeRecord(binding.skills), "configured")
    ? uniqueStrings(binding.skills.configured)
    : [];
  const configuredSkills = readTopLevelSkillRefs(source);
  const bindingSnapshot = {
    agentId: normalizeString(source.id) || null,
    roleRef: normalizeString(source.role)?.toLowerCase()
      || normalizeString(binding.roleRef)?.toLowerCase()
      || null,
    workspace: {},
    model: {},
    heartbeat: {},
    skills: {
      configured: configuredSkills.length > 0 ? configuredSkills : nestedSkills,
    },
    capabilities: {
      configured: bindingCapabilities,
    },
    policies,
  };
  const configuredWorkspace = normalizeString(source.workspace)
    || normalizeString(binding?.workspace?.configured);
  const configuredModelRef = normalizeStoredAgentModelRef(source.model)
    || normalizeStoredAgentModelRef(binding?.model?.ref);
  const configuredHeartbeatEvery = readTopLevelHeartbeatEvery(source)
    || normalizeString(binding?.heartbeat?.configuredEvery);

  if (configuredWorkspace) {
    bindingSnapshot.workspace.configured = configuredWorkspace;
  }
  if (configuredModelRef) {
    bindingSnapshot.model.ref = configuredModelRef;
  }
  if (configuredHeartbeatEvery) {
    bindingSnapshot.heartbeat.configuredEvery = configuredHeartbeatEvery;
  }

  if (Object.keys(bindingSnapshot.workspace).length === 0) {
    delete bindingSnapshot.workspace;
  }
  if (Object.keys(bindingSnapshot.model).length === 0) {
    delete bindingSnapshot.model;
  }
  if (Object.keys(bindingSnapshot.heartbeat).length === 0) {
    delete bindingSnapshot.heartbeat;
  }
  if ((configuredSkills.length === 0) && (nestedSkills.length === 0)) {
    delete bindingSnapshot.skills;
  }
  if (Object.keys(bindingSnapshot.capabilities.configured).length === 0) {
    delete bindingSnapshot.capabilities;
  }
  if (Object.keys(bindingSnapshot.policies).length === 0) {
    delete bindingSnapshot.policies;
  }

  return bindingSnapshot;
}

function cloneConfiguredCapabilities(value) {
  return normalizeCapabilityRecord(value);
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

export function writeStoredAgentBinding(agentConfig, binding) {
  const source = normalizeRecord(agentConfig);
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
  if (configuredSkills.length > 0) {
    source.skills = configuredSkills;
  } else {
    delete source.skills;
  }

  const configuredTools = uniqueTools(configuredCapabilities.tools || []);
  if (configuredTools.length > 0) {
    source.tools = { allow: configuredTools };
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

  if (Object.keys(document).length > 0) {
    source.binding = document;
  } else {
    delete source.binding;
  }
  delete source.source;

  return source;
}

export function normalizeStoredAgentConfig(agentConfig) {
  const normalized = {
    ...normalizeRecord(agentConfig),
  };
  writeStoredAgentBinding(normalized, readStoredAgentBinding(normalized));
  return normalized;
}

export function normalizeStoredAgentBindings(config) {
  const source = normalizeRecord(config);
  const agents = Array.isArray(source?.agents?.list) ? source.agents.list : null;
  if (!agents) {
    return false;
  }

  let changed = false;
  source.agents.list = agents.map((agentConfig) => {
    const previous = JSON.stringify(agentConfig);
    const next = normalizeStoredAgentConfig(agentConfig);
    if (previous !== JSON.stringify(next)) {
      changed = true;
    }
    return next;
  });
  return changed;
}
