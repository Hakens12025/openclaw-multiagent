// Read-side helpers for agent binding store.
// Exports: normalizeStoredAgentModelRef, readStoredAgentBinding
// All W2/W3 read/write configured semantics are preserved here.

import {
  normalizeRecord,
  normalizeString,
  uniqueStrings,
  uniqueTools,
} from "../core/normalize.js";
import { composeDefaultCapabilityProjection } from "./agent-capability-policy.js";

const EXEC_POLICY_BOOLEANS = ["planRequired", "draftLifecycle", "autoFollowUp", "noDirectIntake"];
const EXEC_POLICY_NUMBERS = ["autoPromoteTimeout"];
const EXEC_POLICY_ENUMS = { sessionCleanup: ["immediate", "deferred"] };

// P6-Phase0 (agent-group 三阶段第一步): 通用 binding policy 容器。纯增量 schema，
// 当前无运行时消费者（Phase1 才接入），但有 validate + round-trip 测试。
//   outputPolicy: contractor collectContractorOutbox 硬编码的通用替代 + 为 Phase2
//     AgentGroup 出边聚合（aggregateGroup）预留。
//   inboxPolicy:  routeContractorInbox 保留 DRAFT 的通用替代（preserveDrafts）。
// P6-Phase1: canReceiveRework — reviewer reworkTarget 回退判定从 role 特化迁来
//   （reviewer-verdict.js）。配置缺省时由 role 默认推导（行为等价）。
const OUTPUT_POLICY_ENUMS = { format: ["contract-json", "passthrough"] };
const OUTPUT_POLICY_STRINGS = ["aggregateGroup"];
const OUTPUT_POLICY_BOOLEANS = ["canReceiveRework"];
// P6-Phase1: requiresContract / dedupeConcurrentTracker — heartbeat actionable-work
//   判定从 role 特化迁来（heartbeat-gate.js）。配置缺省时由 role 默认推导（行为等价）。
const INBOX_POLICY_BOOLEANS = ["preserveDrafts", "requiresContract", "dedupeConcurrentTracker"];

export function hasOwn(record, key) {
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

export function readTopLevelTools(source) {
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

  if (source.outputPolicy && typeof source.outputPolicy === "object") {
    policies.outputPolicy = source.outputPolicy;
  }

  if (source.inboxPolicy && typeof source.inboxPolicy === "object") {
    policies.inboxPolicy = source.inboxPolicy;
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

export function normalizeCapabilityRecord(value) {
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

export function sanitizeBindingPolicies(value) {
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

  const outputPolicy = sanitizeOutputPolicy(source.outputPolicy);
  if (outputPolicy) {
    policies.outputPolicy = outputPolicy;
  }

  const inboxPolicy = sanitizeInboxPolicy(source.inboxPolicy);
  if (inboxPolicy) {
    policies.inboxPolicy = inboxPolicy;
  }

  return policies;
}

// P6-Phase0: outputPolicy validate（contract-json/passthrough format +
// aggregateGroup 字符串）。返回 null 表示无有效字段（不落空对象）。
export function sanitizeOutputPolicy(value) {
  const source = normalizeRecord(value);
  if (!source || Object.keys(source).length === 0) return null;
  const op = {};
  for (const [key, allowed] of Object.entries(OUTPUT_POLICY_ENUMS)) {
    if (allowed.includes(source[key])) {
      op[key] = source[key];
    }
  }
  for (const key of OUTPUT_POLICY_STRINGS) {
    const normalized = normalizeString(source[key]);
    if (normalized) {
      op[key] = normalized;
    }
  }
  for (const key of OUTPUT_POLICY_BOOLEANS) {
    if (typeof source[key] === "boolean") {
      op[key] = source[key];
    }
  }
  return Object.keys(op).length > 0 ? op : null;
}

// P6-Phase0: inboxPolicy validate（preserveDrafts 布尔）。
export function sanitizeInboxPolicy(value) {
  const source = normalizeRecord(value);
  if (!source || Object.keys(source).length === 0) return null;
  const ip = {};
  for (const key of INBOX_POLICY_BOOLEANS) {
    if (typeof source[key] === "boolean") {
      ip[key] = source[key];
    }
  }
  return Object.keys(ip).length > 0 ? ip : null;
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
  const nestedSkillRecord = normalizeRecord(binding.skills);
  const hasBindingDocument = hasOwn(source, "binding");
  const hasNestedConfiguredSkills = hasOwn(nestedSkillRecord, "configured");
  const nestedSkills = hasNestedConfiguredSkills
    ? uniqueStrings(nestedSkillRecord.configured)
    : [];
  // Legacy fallback: only read top-level skills as configured when no binding
  // document exists at all (pre-migration agent). Once a binding document is
  // present (even empty), configured skills live exclusively in
  // binding.skills.configured — the top-level is always the effective (runtime)
  // projection and must never be re-read as configured.
  const configuredSkills = !hasBindingDocument ? readTopLevelSkillRefs(source) : [];
  const bindingSnapshot = {
    agentId: normalizeString(source.id) || null,
    roleRef: normalizeString(source.role)?.toLowerCase()
      || normalizeString(binding.roleRef)?.toLowerCase()
      || null,
    workspace: {},
    model: {},
    heartbeat: {},
    skills: {
      configured: hasNestedConfiguredSkills ? nestedSkills : configuredSkills,
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
  if (!hasNestedConfiguredSkills && configuredSkills.length === 0) {
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
