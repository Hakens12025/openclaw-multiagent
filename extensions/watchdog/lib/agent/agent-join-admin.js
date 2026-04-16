import { normalizeRecord, normalizeString, uniqueStrings } from "../core/normalize.js";
import { EVENT_TYPE } from "../core/event-types.js";
import {
  deleteAgentJoinSpec,
  getAgentJoinSpec,
  setAgentJoinEnabled,
  upsertAgentJoinSpec,
} from "./agent-join-registry.js";

function parseTagList(value) {
  return uniqueStrings(
    Array.isArray(value)
      ? value
      : (typeof value === "string" ? value.split(/[\n,]+/g) : []),
  );
}

function mergeNestedRecord(existing, value) {
  return {
    ...(existing && typeof existing === "object" ? existing : {}),
    ...(value && typeof value === "object" ? value : {}),
  };
}

function buildAgentJoinSpecPayload(payload, existing = null) {
  const normalized = normalizeRecord(payload, {});
  const id = normalizeString(normalized.joinId || existing?.id);
  if (!id) {
    throw new Error("missing agent join id");
  }

  const identity = mergeNestedRecord(existing?.identity, normalized.identity);
  const binding = mergeNestedRecord(existing?.binding, normalized.binding);
  const protocol = mergeNestedRecord(existing?.protocol, normalized.protocol);
  const adapter = mergeNestedRecord(existing?.adapter, normalized.adapter);
  const capabilities = mergeNestedRecord(existing?.capabilities, normalized.capabilities);

  return {
    ...existing,
    ...normalized,
    id,
    identity: {
      ...identity,
      ...(normalized.name != null ? { name: normalized.name } : {}),
      ...(normalized.externalAgentId != null ? { externalAgentId: normalized.externalAgentId } : {}),
      ...(normalized.description != null ? { description: normalized.description } : {}),
    },
    binding: {
      ...binding,
      ...(normalized.localAgentId != null ? { localAgentId: normalized.localAgentId } : {}),
      ...(normalized.platformRole != null ? { platformRole: normalized.platformRole } : {}),
      ...(normalized.role != null ? { platformRole: normalized.role } : {}),
      ...(normalized.tags != null ? { tags: normalized.tags } : {}),
      ...(normalized.tagsText != null ? { tags: parseTagList(normalized.tagsText) } : {}),
    },
    protocol: {
      ...protocol,
      ...(normalized.protocolType != null ? { type: normalized.protocolType } : {}),
      ...(normalized.baseUrl != null ? { baseUrl: normalized.baseUrl } : {}),
      ...(normalized.cardPath != null ? { cardPath: normalized.cardPath } : {}),
      ...(normalized.sendPath != null ? { sendPath: normalized.sendPath } : {}),
      ...(normalized.taskPathTemplate != null ? { taskPathTemplate: normalized.taskPathTemplate } : {}),
    },
    adapter: {
      ...adapter,
      ...(normalized.adapterKind != null ? { kind: normalized.adapterKind } : {}),
      ...(normalized.ingressMode != null ? { ingressMode: normalized.ingressMode } : {}),
      ...(normalized.resultMode != null ? { resultMode: normalized.resultMode } : {}),
    },
    capabilities: {
      ...capabilities,
      ...(normalized.acceptsTasks != null ? { acceptsTasks: normalized.acceptsTasks } : {}),
      ...(normalized.reportsStatus != null ? { reportsStatus: normalized.reportsStatus } : {}),
      ...(normalized.yieldsArtifacts != null ? { yieldsArtifacts: normalized.yieldsArtifacts } : {}),
      ...(normalized.supportsSystemActionDelivery != null ? { supportsSystemActionDelivery: normalized.supportsSystemActionDelivery } : {}),
      ...(normalized.supportsSystemAction != null ? { supportsSystemAction: normalized.supportsSystemAction } : {}),
      ...(normalized.supportsStreaming != null ? { supportsStreaming: normalized.supportsStreaming } : {}),
    },
  };
}

async function createOrUpdateAgentJoin({
  mode,
  payload,
  logger,
  onAlert,
}) {
  const joinId = normalizeString(payload.joinId);
  const existing = joinId ? await getAgentJoinSpec(joinId) : null;

  if (mode === "create" && existing) {
    throw new Error(`agent join already exists: ${joinId}`);
  }
  if (mode === "update" && !existing) {
    throw new Error(`unknown agent join id: ${joinId}`);
  }

  const agentJoin = await upsertAgentJoinSpec(buildAgentJoinSpecPayload(payload, existing));

  onAlert?.({
    type: EVENT_TYPE.AGENT_JOIN_UPDATED,
    action: mode === "create" ? "created" : "updated",
    joinId: agentJoin.id,
    enabled: agentJoin.enabled === true,
    status: agentJoin.summary?.status || null,
    ts: Date.now(),
  });
  logger?.info?.(`[watchdog] agent join ${mode}: ${agentJoin.id}`);

  return {
    ok: true,
    action: mode,
    agentJoin,
  };
}

async function setEnabled({
  enabled,
  payload,
  logger,
  onAlert,
}) {
  const joinId = normalizeString(payload.joinId);
  if (!joinId) {
    throw new Error("missing agent join id");
  }

  const agentJoin = await setAgentJoinEnabled(joinId, enabled);

  onAlert?.({
    type: EVENT_TYPE.AGENT_JOIN_UPDATED,
    action: enabled ? "enabled" : "disabled",
    joinId,
    enabled,
    status: agentJoin.summary?.status || null,
    ts: Date.now(),
  });
  logger?.info?.(`[watchdog] agent join ${enabled ? "enabled" : "disabled"}: ${joinId}`);

  return {
    ok: true,
    action: enabled ? "enable" : "disable",
    agentJoin,
  };
}

export async function createAgentJoinDefinition(args) {
  return createOrUpdateAgentJoin({ ...args, mode: "create" });
}

export async function updateAgentJoinDefinition(args) {
  return createOrUpdateAgentJoin({ ...args, mode: "update" });
}

export async function enableAgentJoinDefinition(args) {
  return setEnabled({ ...args, enabled: true });
}

export async function disableAgentJoinDefinition(args) {
  return setEnabled({ ...args, enabled: false });
}

export async function deleteAgentJoinDefinition({
  payload,
  logger,
  onAlert,
}) {
  const joinId = normalizeString(payload.joinId);
  if (!joinId) {
    throw new Error("missing agent join id");
  }

  const existing = await getAgentJoinSpec(joinId);
  if (!existing) {
    return {
      ok: true,
      action: "delete",
      deleted: false,
      agentJoin: null,
    };
  }

  const deleted = await deleteAgentJoinSpec(joinId);
  onAlert?.({
    type: EVENT_TYPE.AGENT_JOIN_UPDATED,
    action: "deleted",
    joinId,
    enabled: false,
    status: null,
    ts: Date.now(),
  });
  logger?.info?.(`[watchdog] agent join deleted: ${joinId}`);

  return {
    ok: true,
    action: "delete",
    deleted: deleted.deleted === true,
    agentJoin: existing,
  };
}
