import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { normalizeBoolean, normalizeRecord, normalizeString, uniqueStrings } from "../core/normalize.js";
import { normalizeAgentRole } from "./agent-identity.js";
import { OC, atomicWriteFile, withLock } from "../state.js";

export const AGENT_JOIN_STORE = join(OC, "workspaces", "controller", ".watchdog-agent-joins.json");
const AGENT_JOIN_STORE_LOCK = "store:agent-joins";

const SUPPORTED_PROTOCOL_TYPES = new Set([
  "a2a",
  "http",
  "manual",
  "openclaw_native",
]);

const SUPPORTED_ADAPTER_KINDS = new Set([
  "a2a_proxy",
  "http_proxy",
  "manual",
  "workspace_bridge",
]);

const SUPPORTED_INGRESS_MODES = new Set([
  "mailbox",
  "manual",
  "push_task",
]);

const SUPPORTED_RESULT_MODES = new Set([
  "callback",
  "mailbox",
  "manual",
  "poll_status",
]);

function normalizeBaseUrl(value) {
  const normalized = normalizeString(value);
  if (!normalized) return null;
  return normalized.replace(/\/+$/g, "");
}

function normalizeStringList(value) {
  return uniqueStrings(
    Array.isArray(value)
      ? value
      : (typeof value === "string" ? value.split(/[\n,]+/g) : []),
  );
}

function normalizeAgentJoinIdentity(value) {
  const source = normalizeRecord(value, {});
  return {
    name: normalizeString(source.name || source.label) || null,
    externalAgentId: normalizeString(source.externalAgentId || source.agentId || source.remoteAgentId) || null,
    description: normalizeString(source.description || source.summary) || null,
  };
}

function normalizeAgentJoinBinding(value, joinId) {
  const source = normalizeRecord(value, {});
  const localAgentId = normalizeString(source.localAgentId || source.agentId || source.alias || source.localId) || joinId;
  return {
    localAgentId,
    platformRole: normalizeAgentRole(
      source.platformRole || source.role || source.targetRole || "agent",
      localAgentId,
    ),
    tags: normalizeStringList(source.tags),
  };
}

function getDefaultProtocolPaths(type) {
  switch (type) {
    case "a2a":
      return {
        cardPath: "/a2a/agent.json",
        sendPath: "/a2a/tasks/send",
        taskPathTemplate: "/a2a/tasks/{taskId}",
      };
    case "http":
      return {
        cardPath: null,
        sendPath: "/tasks",
        taskPathTemplate: "/tasks/{taskId}",
      };
    default:
      return {
        cardPath: null,
        sendPath: null,
        taskPathTemplate: null,
      };
  }
}

function normalizeAgentJoinProtocol(value) {
  const source = normalizeRecord(value, {});
  const rawType = normalizeString(source.type || source.protocol || source.kind)?.toLowerCase() || "a2a";
  const type = SUPPORTED_PROTOCOL_TYPES.has(rawType) ? rawType : null;
  if (!type) return null;

  const defaults = getDefaultProtocolPaths(type);
  return {
    type,
    baseUrl: normalizeBaseUrl(source.baseUrl || source.url || source.endpoint),
    cardPath: normalizeString(source.cardPath || source.agentCardPath) || defaults.cardPath,
    sendPath: normalizeString(source.sendPath || source.taskSendPath || source.submitPath) || defaults.sendPath,
    taskPathTemplate: normalizeString(
      source.taskPathTemplate || source.statusPathTemplate || source.taskStatusPath,
    ) || defaults.taskPathTemplate,
  };
}

function getDefaultAdapter(protocol) {
  switch (protocol?.type) {
    case "openclaw_native":
      return {
        kind: "workspace_bridge",
        ingressMode: "mailbox",
        resultMode: "mailbox",
      };
    case "http":
      return {
        kind: "http_proxy",
        ingressMode: "push_task",
        resultMode: "poll_status",
      };
    case "manual":
      return {
        kind: "manual",
        ingressMode: "manual",
        resultMode: "manual",
      };
    case "a2a":
    default:
      return {
        kind: "a2a_proxy",
        ingressMode: "push_task",
        resultMode: "poll_status",
      };
  }
}

function normalizeAgentJoinAdapter(value, protocol) {
  const source = normalizeRecord(value, {});
  const defaults = getDefaultAdapter(protocol);
  const rawKind = normalizeString(source.kind || source.adapter)?.toLowerCase() || defaults.kind;
  const rawIngressMode = normalizeString(source.ingressMode || source.inputMode)?.toLowerCase() || defaults.ingressMode;
  const rawResultMode = normalizeString(source.resultMode || source.outputMode)?.toLowerCase() || defaults.resultMode;

  return {
    kind: SUPPORTED_ADAPTER_KINDS.has(rawKind) ? rawKind : defaults.kind,
    ingressMode: SUPPORTED_INGRESS_MODES.has(rawIngressMode) ? rawIngressMode : defaults.ingressMode,
    resultMode: SUPPORTED_RESULT_MODES.has(rawResultMode) ? rawResultMode : defaults.resultMode,
  };
}

function normalizeCapabilityFlag(source, key, fallback) {
  if (!source || !(key in source)) return fallback;
  return normalizeBoolean(source[key]);
}

function normalizeAgentJoinCapabilities(value, protocol, adapter) {
  const source = normalizeRecord(value, {});
  const taskCapable = adapter?.ingressMode !== "manual";
  const statusCapable = adapter?.resultMode === "poll_status";
  return {
    acceptsTasks: normalizeCapabilityFlag(source, "acceptsTasks", taskCapable),
    reportsStatus: normalizeCapabilityFlag(source, "reportsStatus", statusCapable),
    yieldsArtifacts: normalizeCapabilityFlag(source, "yieldsArtifacts", true),
    supportsSystemActionDelivery: normalizeCapabilityFlag(source, "supportsSystemActionDelivery", false),
    supportsSystemAction: normalizeCapabilityFlag(source, "supportsSystemAction", false),
    supportsStreaming: normalizeCapabilityFlag(source, "supportsStreaming", protocol?.type === "a2a"),
  };
}

function listMissingRequirements(spec) {
  const missing = [];
  if (!normalizeString(spec?.id)) missing.push("id");
  if (!normalizeString(spec?.binding?.localAgentId)) missing.push("binding.localAgentId");
  if (!normalizeString(spec?.binding?.platformRole)) missing.push("binding.platformRole");

  const protocolType = spec?.protocol?.type;
  if (protocolType === "a2a" || protocolType === "http") {
    if (!normalizeString(spec?.protocol?.baseUrl)) missing.push("protocol.baseUrl");
    if (!normalizeString(spec?.protocol?.sendPath)) missing.push("protocol.sendPath");
  }
  if ((protocolType === "a2a" || protocolType === "http") && !normalizeString(spec?.protocol?.taskPathTemplate)) {
    missing.push("protocol.taskPathTemplate");
  }

  return missing;
}

function buildAgentJoinSummary(spec) {
  const missingRequirements = listMissingRequirements(spec);
  const status = spec?.enabled === true
    ? (missingRequirements.length > 0 ? "draft" : "ready")
    : "disabled";
  return {
    status,
    missingRequirements,
    localAgentId: spec?.binding?.localAgentId || null,
    platformRole: spec?.binding?.platformRole || null,
    protocolType: spec?.protocol?.type || null,
    adapterKind: spec?.adapter?.kind || null,
    baseUrl: spec?.protocol?.baseUrl || null,
  };
}

export function normalizeAgentJoinSpec(value) {
  const source = normalizeRecord(value, null);
  if (!source) return null;

  const id = normalizeString(source.id || source.name);
  if (!id) return null;

  const identity = normalizeAgentJoinIdentity({
    ...(normalizeRecord(source.identity, {})),
    ...(normalizeString(source.name) ? { name: source.name } : {}),
    ...(normalizeString(source.externalAgentId) ? { externalAgentId: source.externalAgentId } : {}),
    ...(normalizeString(source.description) ? { description: source.description } : {}),
  });
  const binding = normalizeAgentJoinBinding({
    ...(normalizeRecord(source.binding, {})),
    ...(normalizeString(source.localAgentId) ? { localAgentId: source.localAgentId } : {}),
    ...(normalizeString(source.platformRole || source.role) ? { platformRole: source.platformRole || source.role } : {}),
    ...(source.tags != null ? { tags: source.tags } : {}),
  }, id);
  const protocol = normalizeAgentJoinProtocol({
    ...(normalizeRecord(source.protocol, {})),
    ...(normalizeString(source.protocolType) ? { type: source.protocolType } : {}),
    ...(normalizeString(source.baseUrl) ? { baseUrl: source.baseUrl } : {}),
    ...(normalizeString(source.cardPath) ? { cardPath: source.cardPath } : {}),
    ...(normalizeString(source.sendPath) ? { sendPath: source.sendPath } : {}),
    ...(normalizeString(source.taskPathTemplate) ? { taskPathTemplate: source.taskPathTemplate } : {}),
  });
  if (!protocol) return null;

  const adapter = normalizeAgentJoinAdapter({
    ...(normalizeRecord(source.adapter, {})),
    ...(normalizeString(source.adapterKind) ? { kind: source.adapterKind } : {}),
    ...(normalizeString(source.ingressMode) ? { ingressMode: source.ingressMode } : {}),
    ...(normalizeString(source.resultMode) ? { resultMode: source.resultMode } : {}),
  }, protocol);
  const capabilities = normalizeAgentJoinCapabilities({
    ...(normalizeRecord(source.capabilities, {})),
    ...(source.acceptsTasks != null ? { acceptsTasks: source.acceptsTasks } : {}),
    ...(source.reportsStatus != null ? { reportsStatus: source.reportsStatus } : {}),
    ...(source.yieldsArtifacts != null ? { yieldsArtifacts: source.yieldsArtifacts } : {}),
    ...(source.supportsSystemActionDelivery != null ? { supportsSystemActionDelivery: source.supportsSystemActionDelivery } : {}),
    ...(source.supportsSystemAction != null ? { supportsSystemAction: source.supportsSystemAction } : {}),
    ...(source.supportsStreaming != null ? { supportsStreaming: source.supportsStreaming } : {}),
  }, protocol, adapter);

  const normalized = {
    id,
    enabled: source.enabled == null ? true : normalizeBoolean(source.enabled),
    identity,
    binding,
    protocol,
    adapter,
    capabilities,
    notes: normalizeString(source.notes) || null,
    createdAt: Number.isFinite(source.createdAt) ? source.createdAt : null,
    updatedAt: Number.isFinite(source.updatedAt) ? source.updatedAt : null,
  };

  return {
    ...normalized,
    summary: buildAgentJoinSummary(normalized),
  };
}

async function readAgentJoinStore() {
  try {
    return JSON.parse(await readFile(AGENT_JOIN_STORE, "utf8"));
  } catch {
    return {};
  }
}

function sortAgentJoins(agentJoins) {
  return [...(Array.isArray(agentJoins) ? agentJoins : [])]
    .sort((left, right) => String(left?.id || "").localeCompare(String(right?.id || "")));
}

async function writeAgentJoinStore(agentJoins) {
  const normalized = sortAgentJoins(
    (Array.isArray(agentJoins) ? agentJoins : [])
      .map((entry) => normalizeAgentJoinSpec(entry))
      .filter(Boolean),
  );
  const now = Date.now();
  await mkdir(join(OC, "workspaces", "controller"), { recursive: true });
  await atomicWriteFile(AGENT_JOIN_STORE, JSON.stringify({
    updatedAt: now,
    agentJoins: normalized,
  }, null, 2));
  return normalized;
}

export async function listAgentJoinSpecs({
  enabled = null,
  status = null,
  protocolType = null,
} = {}) {
  const parsed = await readAgentJoinStore();
  const entries = Array.isArray(parsed?.agentJoins) ? parsed.agentJoins : [];
  const normalizedStatus = normalizeString(status)?.toLowerCase() || null;
  const normalizedProtocolType = normalizeString(protocolType)?.toLowerCase() || null;
  return sortAgentJoins(entries
    .map((entry) => normalizeAgentJoinSpec(entry))
    .filter(Boolean)
    .filter((entry) => (typeof enabled === "boolean" ? entry.enabled === enabled : true))
    .filter((entry) => (normalizedStatus ? entry.summary?.status === normalizedStatus : true))
    .filter((entry) => (normalizedProtocolType ? entry.protocol?.type === normalizedProtocolType : true)));
}

export async function getAgentJoinSpec(joinId) {
  const normalizedId = normalizeString(joinId);
  if (!normalizedId) return null;
  const specs = await listAgentJoinSpecs();
  return specs.find((entry) => entry.id === normalizedId) || null;
}

export async function summarizeAgentJoinRegistry(options = {}) {
  const agentJoins = await listAgentJoinSpecs(options);
  const counts = {
    total: agentJoins.length,
    enabled: agentJoins.filter((entry) => entry.enabled === true).length,
    disabled: agentJoins.filter((entry) => entry.enabled !== true).length,
    ready: agentJoins.filter((entry) => entry.summary?.status === "ready").length,
    draft: agentJoins.filter((entry) => entry.summary?.status === "draft").length,
    byProtocol: {},
  };
  for (const entry of agentJoins) {
    const protocolType = entry?.protocol?.type || "unknown";
    counts.byProtocol[protocolType] = (counts.byProtocol[protocolType] || 0) + 1;
  }
  return {
    agentJoins,
    counts,
  };
}

export async function upsertAgentJoinSpec(agentJoinSpec) {
  const normalized = normalizeAgentJoinSpec(agentJoinSpec);
  if (!normalized?.id) {
    throw new Error("invalid agent join spec");
  }

  return withLock(AGENT_JOIN_STORE_LOCK, async () => {
    const now = Date.now();
    const agentJoins = await listAgentJoinSpecs();
    const existing = agentJoins.find((entry) => entry.id === normalized.id) || null;
    const nextAgentJoins = agentJoins
      .filter((entry) => entry.id !== normalized.id)
      .concat({
        ...normalized,
        createdAt: Number.isFinite(existing?.createdAt) ? existing.createdAt : now,
        updatedAt: now,
      });
    const saved = await writeAgentJoinStore(nextAgentJoins);
    return saved.find((entry) => entry.id === normalized.id) || null;
  });
}

export async function setAgentJoinEnabled(joinId, enabled) {
  const normalizedId = normalizeString(joinId);
  if (!normalizedId) {
    throw new Error("missing agent join id");
  }

  return withLock(AGENT_JOIN_STORE_LOCK, async () => {
    const now = Date.now();
    const agentJoins = await listAgentJoinSpecs();
    const existing = agentJoins.find((entry) => entry.id === normalizedId) || null;
    if (!existing) {
      throw new Error(`unknown agent join id: ${normalizedId}`);
    }

    const nextAgentJoins = agentJoins
      .filter((entry) => entry.id !== normalizedId)
      .concat({
        ...existing,
        enabled: enabled === true,
        createdAt: Number.isFinite(existing?.createdAt) ? existing.createdAt : now,
        updatedAt: now,
      });
    const saved = await writeAgentJoinStore(nextAgentJoins);
    return saved.find((entry) => entry.id === normalizedId) || null;
  });
}

export async function deleteAgentJoinSpec(joinId) {
  const normalizedId = normalizeString(joinId);
  if (!normalizedId) {
    throw new Error("missing agent join id");
  }

  return withLock(AGENT_JOIN_STORE_LOCK, async () => {
    const agentJoins = await listAgentJoinSpecs();
    const existing = agentJoins.find((entry) => entry.id === normalizedId) || null;
    if (!existing) {
      return {
        ok: true,
        deleted: false,
        agentJoin: null,
      };
    }

    await writeAgentJoinStore(agentJoins.filter((entry) => entry.id !== normalizedId));
    return {
      ok: true,
      deleted: true,
      agentJoin: existing,
    };
  });
}
