import { normalizeRecord, normalizeString } from "../core/normalize.js";
import { EVENT_TYPE } from "../core/event-types.js";
import {
  deleteScheduleSpec,
  getScheduleSpec,
  setScheduleEnabled,
  upsertScheduleSpec,
} from "./schedule-registry.js";
import {
  removeScheduleMaterialization,
  syncScheduleMaterialization,
} from "./schedule-materializer.js";

function parseStringList(value) {
  const values = Array.isArray(value)
    ? value
    : (typeof value === "string" ? value.split(/[\n,]+/g) : []);
  return [...new Set(values
    .map((item) => normalizeString(item))
    .filter(Boolean))];
}

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

function buildScheduleSpecPayload(payload, existing = null) {
  const normalized = normalizeRecord(payload, {});
  const id = normalizeString(normalized.scheduleId || existing?.id);
  if (!id) {
    throw new Error("missing schedule id");
  }

  const entry = mergeNestedRecord(existing?.entry, normalized.entry);
  const systemActionDelivery = mergeNestedRecord(existing?.systemActionDelivery, normalized.systemActionDelivery);
  const resultPolicy = mergeNestedRecord(existing?.resultPolicy, normalized.resultPolicy);
  const concurrency = mergeNestedRecord(existing?.concurrency, normalized.concurrency);
  const nextDeliveryTargets = resolveDeliveryTargets(normalized);

  return {
    ...existing,
    ...normalized,
    id,
    trigger: mergeNestedRecord(existing?.trigger, normalized.trigger),
    entry,
    systemActionDelivery: {
      ...systemActionDelivery,
      agentId: normalizeString(systemActionDelivery.agentId || entry.targetAgent) || null,
      sessionKey: normalizeString(systemActionDelivery.sessionKey) || null,
    },
    deliveryTargets: nextDeliveryTargets.length > 0
      ? nextDeliveryTargets
      : (Array.isArray(existing?.deliveryTargets) ? existing.deliveryTargets : []),
    resultPolicy: {
      ...resultPolicy,
      notifyOn: parseStringList(resultPolicy.notifyOn),
    },
    concurrency: {
      ...concurrency,
      skipIfRunning: concurrency.skipIfRunning,
    },
  };
}

function requireScheduleRuntime(runtimeContext) {
  if (!runtimeContext?.api) {
    throw new Error("missing runtime api for schedule admin");
  }
  return runtimeContext.api;
}

async function createOrUpdateSchedule({
  mode,
  payload,
  logger,
  onAlert,
  runtimeContext,
}) {
  requireScheduleRuntime(runtimeContext);
  const scheduleId = normalizeString(payload.scheduleId);
  const existing = scheduleId ? await getScheduleSpec(scheduleId) : null;

  if (mode === "create" && existing) {
    throw new Error(`schedule already exists: ${scheduleId}`);
  }
  if (mode === "update" && !existing) {
    throw new Error(`unknown schedule id: ${scheduleId}`);
  }

  const schedule = await upsertScheduleSpec(buildScheduleSpecPayload(payload, existing));
  const materialization = await syncScheduleMaterialization(schedule, {
    api: runtimeContext.api,
    logger,
  });

  onAlert?.({
    type: EVENT_TYPE.SCHEDULE_UPDATED,
    action: mode === "create" ? "created" : "updated",
    scheduleId: schedule.id,
    enabled: schedule.enabled === true,
    jobId: materialization?.jobId || null,
    ts: Date.now(),
  });

  return {
    ok: true,
    action: mode,
    schedule,
    materialization,
  };
}

async function setEnabled({
  enabled,
  payload,
  logger,
  onAlert,
  runtimeContext,
}) {
  requireScheduleRuntime(runtimeContext);
  const scheduleId = normalizeString(payload.scheduleId);
  if (!scheduleId) {
    throw new Error("missing schedule id");
  }

  const schedule = await setScheduleEnabled(scheduleId, enabled);
  const materialization = await syncScheduleMaterialization(schedule, {
    api: runtimeContext.api,
    logger,
  });

  onAlert?.({
    type: EVENT_TYPE.SCHEDULE_UPDATED,
    action: enabled ? "enabled" : "disabled",
    scheduleId,
    enabled,
    jobId: materialization?.jobId || null,
    ts: Date.now(),
  });

  return {
    ok: true,
    action: enabled ? "enable" : "disable",
    schedule,
    materialization,
  };
}

export async function createScheduleDefinition(args) {
  return createOrUpdateSchedule({ ...args, mode: "create" });
}

export async function updateScheduleDefinition(args) {
  return createOrUpdateSchedule({ ...args, mode: "update" });
}

export async function enableScheduleDefinition(args) {
  return setEnabled({ ...args, enabled: true });
}

export async function disableScheduleDefinition(args) {
  return setEnabled({ ...args, enabled: false });
}

export async function deleteScheduleDefinition({
  payload,
  logger,
  onAlert,
  runtimeContext,
}) {
  requireScheduleRuntime(runtimeContext);
  const scheduleId = normalizeString(payload.scheduleId);
  if (!scheduleId) {
    throw new Error("missing schedule id");
  }

  const existing = await getScheduleSpec(scheduleId);
  if (!existing) {
    return {
      ok: true,
      action: "delete",
      deleted: false,
      schedule: null,
      materialization: {
        ok: true,
        removed: false,
        jobId: null,
      },
    };
  }

  const materialization = await removeScheduleMaterialization(scheduleId, {
    api: runtimeContext.api,
    logger,
  });
  const deleted = await deleteScheduleSpec(scheduleId);

  onAlert?.({
    type: EVENT_TYPE.SCHEDULE_UPDATED,
    action: "deleted",
    scheduleId,
    enabled: false,
    jobId: materialization?.jobId || null,
    ts: Date.now(),
  });

  return {
    ok: true,
    action: "delete",
    deleted: deleted.deleted === true,
    schedule: existing,
    materialization,
  };
}
