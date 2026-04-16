import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { normalizeBoolean, normalizeRecord, normalizeString } from "../core/normalize.js";
import { normalizeDeliveryTargets } from "../routing/delivery-targets.js";
import { OC, atomicWriteFile, withLock } from "../state.js";
import { buildAgentMainSessionKey } from "../session-keys.js";

export const SCHEDULE_STORE = join(OC, "workspaces", "controller", ".watchdog-schedules.json");
const SCHEDULE_STORE_LOCK = "store:schedules";

function normalizeScheduleTrigger(value) {
  const source = normalizeRecord(value, null);
  if (!source) return null;

  const type = normalizeString(source.type)?.toLowerCase();
  const expr = normalizeString(source.expr || source.cron || source.schedule);
  if (type !== "cron" || !expr) return null;

  return {
    type,
    expr,
    tz: normalizeString(source.tz || source.timezone) || "Asia/Shanghai",
  };
}

function normalizeScheduleEntry(value) {
  const source = normalizeRecord(value, null);
  if (!source) return null;

  const type = normalizeString(source.type)?.toLowerCase() || "workflow";
  const targetAgent = normalizeString(source.targetAgent || source.agentId);
  const message = normalizeString(source.message || source.task || source.instruction);
  if (!targetAgent || !message) return null;

  return {
    type,
    targetAgent,
    message,
    routeHint: normalizeString(source.routeHint) || null,
  };
}

function normalizeScheduleSystemActionDelivery(value) {
  const source = normalizeRecord(value, null);
  if (!source) return null;

  const agentId = normalizeString(source.agentId);
  if (!agentId) return null;

  return {
    agentId,
    sessionKey: normalizeString(source.sessionKey) || buildAgentMainSessionKey(agentId),
  };
}

function normalizeScheduleResultPolicy(value) {
  const source = normalizeRecord(value, null);
  if (!source) {
    return {
      format: "summary_with_artifacts",
      notifyOn: ["success", "failed"],
    };
  }

  const format = normalizeString(source.format) || "summary_with_artifacts";
  const notifyOn = [...new Set((Array.isArray(source.notifyOn) ? source.notifyOn : ["success", "failed"])
    .map((item) => normalizeString(item)?.toLowerCase())
    .filter(Boolean))];

  return {
    format,
    notifyOn: notifyOn.length > 0 ? notifyOn : ["success", "failed"],
  };
}

function normalizeScheduleConcurrency(value) {
  const source = normalizeRecord(value, null);
  return {
    skipIfRunning: source ? normalizeBoolean(source.skipIfRunning) : true,
  };
}

export function normalizeScheduleSpec(value) {
  const source = normalizeRecord(value, null);
  if (!source) return null;

  const id = normalizeString(source.id || source.name);
  const trigger = normalizeScheduleTrigger(source.trigger);
  const entry = normalizeScheduleEntry(source.entry);
  if (!id || !trigger || !entry) return null;

  return {
    id,
    enabled: source.enabled == null ? true : normalizeBoolean(source.enabled),
    trigger,
    entry,
    systemActionDelivery: normalizeScheduleSystemActionDelivery(source.systemActionDelivery),
    deliveryTargets: normalizeDeliveryTargets(source.deliveryTargets || []),
    resultPolicy: normalizeScheduleResultPolicy(source.resultPolicy),
    concurrency: normalizeScheduleConcurrency(source.concurrency),
    createdAt: Number.isFinite(source.createdAt) ? source.createdAt : null,
    updatedAt: Number.isFinite(source.updatedAt) ? source.updatedAt : null,
  };
}

async function readScheduleStore() {
  try {
    return JSON.parse(await readFile(SCHEDULE_STORE, "utf8"));
  } catch {
    return {};
  }
}

function sortSchedules(schedules) {
  return [...(Array.isArray(schedules) ? schedules : [])]
    .sort((left, right) => String(left?.id || "").localeCompare(String(right?.id || "")));
}

async function writeScheduleStore(schedules) {
  const normalized = sortSchedules(
    (Array.isArray(schedules) ? schedules : [])
      .map((entry) => normalizeScheduleSpec(entry))
      .filter(Boolean),
  );
  const now = Date.now();
  await mkdir(join(OC, "workspaces", "controller"), { recursive: true });
  await atomicWriteFile(SCHEDULE_STORE, JSON.stringify({
    updatedAt: now,
    schedules: normalized,
  }, null, 2));
  return normalized;
}

async function listScheduleSpecs({
  enabled = null,
} = {}) {
  const parsed = await readScheduleStore();
  const entries = Array.isArray(parsed?.schedules) ? parsed.schedules : [];
  return sortSchedules(entries
    .map((entry) => normalizeScheduleSpec(entry))
    .filter(Boolean)
    .filter((entry) => (typeof enabled === "boolean" ? entry.enabled === enabled : true)));
}

export async function getScheduleSpec(scheduleId) {
  const normalizedId = normalizeString(scheduleId);
  if (!normalizedId) return null;
  const schedules = await listScheduleSpecs();
  return schedules.find((entry) => entry.id === normalizedId) || null;
}

export async function summarizeScheduleRegistry(options = {}) {
  const schedules = await listScheduleSpecs(options);
  return {
    schedules,
    counts: {
      total: schedules.length,
      enabled: schedules.filter((entry) => entry.enabled === true).length,
      disabled: schedules.filter((entry) => entry.enabled !== true).length,
    },
  };
}

export async function upsertScheduleSpec(scheduleSpec) {
  const normalized = normalizeScheduleSpec(scheduleSpec);
  if (!normalized?.id) {
    throw new Error("invalid schedule spec");
  }

  return withLock(SCHEDULE_STORE_LOCK, async () => {
    const now = Date.now();
    const schedules = await listScheduleSpecs();
    const existing = schedules.find((entry) => entry.id === normalized.id) || null;
    const nextSchedules = schedules
      .filter((entry) => entry.id !== normalized.id)
      .concat({
        ...normalized,
        createdAt: Number.isFinite(existing?.createdAt) ? existing.createdAt : now,
        updatedAt: now,
      });
    const saved = await writeScheduleStore(nextSchedules);
    return saved.find((entry) => entry.id === normalized.id) || null;
  });
}

export async function setScheduleEnabled(scheduleId, enabled) {
  const normalizedId = normalizeString(scheduleId);
  if (!normalizedId) {
    throw new Error("missing schedule id");
  }

  return withLock(SCHEDULE_STORE_LOCK, async () => {
    const now = Date.now();
    const schedules = await listScheduleSpecs();
    const existing = schedules.find((entry) => entry.id === normalizedId) || null;
    if (!existing) {
      throw new Error(`unknown schedule id: ${normalizedId}`);
    }

    const nextSchedules = schedules
      .filter((entry) => entry.id !== normalizedId)
      .concat({
        ...existing,
        enabled: enabled === true,
        createdAt: Number.isFinite(existing?.createdAt) ? existing.createdAt : now,
        updatedAt: now,
      });
    const saved = await writeScheduleStore(nextSchedules);
    return saved.find((entry) => entry.id === normalizedId) || null;
  });
}

export async function deleteScheduleSpec(scheduleId) {
  const normalizedId = normalizeString(scheduleId);
  if (!normalizedId) {
    throw new Error("missing schedule id");
  }

  return withLock(SCHEDULE_STORE_LOCK, async () => {
    const schedules = await listScheduleSpecs();
    const existing = schedules.find((entry) => entry.id === normalizedId) || null;
    if (!existing) {
      return {
        ok: true,
        deleted: false,
        schedule: null,
      };
    }

    await writeScheduleStore(schedules.filter((entry) => entry.id !== normalizedId));
    return {
      ok: true,
      deleted: true,
      schedule: existing,
    };
  });
}
