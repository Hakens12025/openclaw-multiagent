import { normalizeRecord, normalizeString } from "../core/normalize.js";
import { EVENT_TYPE } from "../core/event-types.js";
import {
  deleteAutomationSpec,
  getAutomationSpec,
  setAutomationEnabled,
  upsertAutomationSpec,
} from "./automation-registry.js";
import {
  deleteAutomationRuntimeState,
  ensureAutomationRuntimeState,
  setAutomationRuntimeStatus,
} from "./automation-runtime.js";
import { startAutomationRound } from "./automation-executor.js";

function parseDeliveryTargetsText(value) {
  const text = normalizeString(value);
  if (!text) return [];

  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed;
    if (parsed && typeof parsed === "object") return [parsed];
  } catch {}

  return text
    .split(/\n+/g)
    .map((line) => normalizeString(line))
    .filter(Boolean)
    .map((line) => {
      const [channel, target, mode] = line.includes("|")
        ? line.split("|").map((item) => item.trim())
        : line.split(/\s+/g);
      return {
        channel,
        target,
        ...(normalizeString(mode) ? { mode: normalizeString(mode) } : {}),
      };
    });
}

function resolveDeliveryTargets(payload) {
  if (Array.isArray(payload.deliveryTargets)) {
    return payload.deliveryTargets;
  }
  return parseDeliveryTargetsText(payload.deliveryTargetsText || payload.deliveryTargetsJson);
}

function mergeNestedRecord(existing, value) {
  return {
    ...(existing && typeof existing === "object" ? existing : {}),
    ...(value && typeof value === "object" ? value : {}),
  };
}

function buildAutomationSpecPayload(payload, existing = null) {
  const normalized = normalizeRecord(payload, {});
  const id = normalizeString(normalized.automationId || existing?.id);
  if (!id) {
    throw new Error("missing automation id");
  }

  const objective = mergeNestedRecord(existing?.objective, normalized.objective);
  const entry = mergeNestedRecord(existing?.entry, normalized.entry);
  const adapters = mergeNestedRecord(existing?.adapters, normalized.adapters);
  const wakePolicy = mergeNestedRecord(existing?.wakePolicy, normalized.wakePolicy);
  const governance = mergeNestedRecord(existing?.governance, normalized.governance);
  const systemActionDelivery = mergeNestedRecord(existing?.systemActionDelivery, normalized.systemActionDelivery);
  const harness = mergeNestedRecord(existing?.harness, normalized.harness);
  const nextDeliveryTargets = resolveDeliveryTargets(normalized);

  return {
    ...existing,
    ...normalized,
    id,
    objective: {
      ...objective,
      ...(normalized.summary != null ? { summary: normalized.summary } : {}),
      ...(normalized.goal != null ? { summary: normalized.goal } : {}),
      ...(normalized.description != null ? { summary: normalized.description } : {}),
      ...(normalized.instruction != null ? { instruction: normalized.instruction } : {}),
      ...(normalized.message != null ? { instruction: normalized.message } : {}),
      ...(normalized.task != null ? { instruction: normalized.task } : {}),
      ...(normalized.domain != null ? { domain: normalized.domain } : {}),
      ...(normalized.successSignal != null ? { successSignal: normalized.successSignal } : {}),
      ...(normalized.successCriteria != null ? { successSignal: normalized.successCriteria } : {}),
    },
    entry: {
      ...entry,
      ...(normalized.targetAgent != null ? { targetAgent: normalized.targetAgent } : {}),
      ...(normalized.agentId != null ? { targetAgent: normalized.agentId } : {}),
      ...(normalized.routeHint != null ? { routeHint: normalized.routeHint } : {}),
    },
    adapters: {
      ...adapters,
      ...(normalized.domain != null ? { domain: normalized.domain } : {}),
    },
    wakePolicy,
    governance,
    systemActionDelivery,
    harness: {
      ...harness,
      ...(normalized.executionMode != null ? { mode: normalized.executionMode } : {}),
      ...(normalized.assuranceLevel != null ? { assuranceLevel: normalized.assuranceLevel } : {}),
      ...(normalized.harnessProfile != null ? { profileId: normalized.harnessProfile } : {}),
      ...(normalized.harnessProfileId != null ? { profileId: normalized.harnessProfileId } : {}),
      ...(normalized.profileId != null ? { profileId: normalized.profileId } : {}),
      ...(normalized.harnessCoverage && typeof normalized.harnessCoverage === "object"
        ? { coverage: normalized.harnessCoverage }
        : {}),
    },
    deliveryTargets: nextDeliveryTargets.length > 0
      ? nextDeliveryTargets
      : (Array.isArray(existing?.deliveryTargets) ? existing.deliveryTargets : []),
  };
}

async function createOrUpdateAutomation({
  mode,
  payload,
  logger,
  onAlert,
}) {
  const automationId = normalizeString(payload.automationId);
  const existing = automationId ? await getAutomationSpec(automationId) : null;

  if (mode === "create" && existing) {
    throw new Error(`automation already exists: ${automationId}`);
  }
  if (mode === "update" && !existing) {
    throw new Error(`unknown automation id: ${automationId}`);
  }

  const automation = await upsertAutomationSpec(buildAutomationSpecPayload(payload, existing));
  const runtime = await ensureAutomationRuntimeState(automation);

  onAlert?.({
    type: EVENT_TYPE.AUTOMATION_UPDATED,
    action: mode === "create" ? "created" : "updated",
    automationId: automation.id,
    enabled: automation.enabled === true,
    runtimeStatus: runtime?.status || null,
    ts: Date.now(),
  });
  logger?.info?.(`[watchdog] automation ${mode}: ${automation.id}`);

  return {
    ok: true,
    action: mode,
    automation,
    runtime,
  };
}

async function setEnabled({
  enabled,
  payload,
  logger,
  onAlert,
}) {
  const automationId = normalizeString(payload.automationId);
  if (!automationId) {
    throw new Error("missing automation id");
  }

  const automation = await setAutomationEnabled(automationId, enabled);
  await ensureAutomationRuntimeState(automation);
  const runtime = await setAutomationRuntimeStatus(automationId, enabled ? "idle" : "paused");

  onAlert?.({
    type: EVENT_TYPE.AUTOMATION_UPDATED,
    action: enabled ? "enabled" : "disabled",
    automationId,
    enabled,
    runtimeStatus: runtime?.status || null,
    ts: Date.now(),
  });
  logger?.info?.(`[watchdog] automation ${enabled ? "enabled" : "disabled"}: ${automationId}`);

  return {
    ok: true,
    action: enabled ? "enable" : "disable",
    automation,
    runtime,
  };
}

export async function createAutomationDefinition(args) {
  return createOrUpdateAutomation({ ...args, mode: "create" });
}

export async function updateAutomationDefinition(args) {
  return createOrUpdateAutomation({ ...args, mode: "update" });
}

export async function enableAutomationDefinition(args) {
  return setEnabled({ ...args, enabled: true });
}

export async function disableAutomationDefinition(args) {
  return setEnabled({ ...args, enabled: false });
}

export async function deleteAutomationDefinition({
  payload,
  logger,
  onAlert,
}) {
  const automationId = normalizeString(payload.automationId);
  if (!automationId) {
    throw new Error("missing automation id");
  }

  const existing = await getAutomationSpec(automationId);
  if (!existing) {
    return {
      ok: true,
      action: "delete",
      deleted: false,
      automation: null,
      runtime: null,
    };
  }

  const runtime = await deleteAutomationRuntimeState(automationId);
  const deleted = await deleteAutomationSpec(automationId);

  onAlert?.({
    type: EVENT_TYPE.AUTOMATION_UPDATED,
    action: "deleted",
    automationId,
    enabled: false,
    runtimeStatus: null,
    ts: Date.now(),
  });
  logger?.info?.(`[watchdog] automation deleted: ${automationId}`);

  return {
    ok: true,
    action: "delete",
    deleted: deleted.deleted === true,
    automation: existing,
    runtime,
  };
}

export async function runAutomationDefinition({
  payload,
  logger,
  onAlert,
  runtimeContext,
}) {
  const automationId = normalizeString(payload.automationId);
  if (!automationId) {
    throw new Error("missing automation id");
  }

  return startAutomationRound(automationId, {
    trigger: normalizeString(payload.trigger) || "manual",
    api: runtimeContext?.api,
    enqueue: runtimeContext?.enqueue,
    wakePlanner: runtimeContext?.wakePlanner,
    logger,
    onAlert,
  });
}
