import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { normalizeBoolean, normalizeRecord, normalizeString } from "../core/normalize.js";
import { buildScheduleTriggerCommandMessage } from "./schedule-trigger.js";
import { OC, atomicWriteFile, cfg, withLock } from "../state.js";

export const SCHEDULE_MATERIALIZER_STORE = join(
  OC,
  "workspaces",
  "controller",
  ".watchdog-schedule-materializer.json",
);

const CRON_COMMAND_TIMEOUT_MS = 20_000;
const SCHEDULE_MATERIALIZER_STORE_LOCK = "store:schedule-materializer";

function buildGatewayCliArgs() {
  const args = [];
  if (cfg.gatewayPort) {
    args.push("--url", `ws://127.0.0.1:${cfg.gatewayPort}`);
  }
  if (cfg.gatewayToken) {
    args.push("--token", cfg.gatewayToken);
  }
  return args;
}

function normalizeMaterializationEntry(value) {
  const source = normalizeRecord(value, null);
  if (!source) return null;

  const scheduleId = normalizeString(source.scheduleId);
  if (!scheduleId) return null;

  return {
    scheduleId,
    jobId: normalizeString(source.jobId) || null,
    jobName: normalizeString(source.jobName) || null,
    enabled: source.enabled == null ? null : normalizeBoolean(source.enabled),
    syncedAt: Number.isFinite(source.syncedAt) ? source.syncedAt : null,
    updatedAt: Number.isFinite(source.updatedAt) ? source.updatedAt : null,
    lastAction: normalizeString(source.lastAction) || null,
    lastError: normalizeString(source.lastError) || null,
  };
}

function sortEntries(entries) {
  return [...(Array.isArray(entries) ? entries : [])]
    .sort((left, right) => String(left?.scheduleId || "").localeCompare(String(right?.scheduleId || "")));
}

async function readMaterializerStore() {
  try {
    return JSON.parse(await readFile(SCHEDULE_MATERIALIZER_STORE, "utf8"));
  } catch {
    return {};
  }
}

async function writeMaterializerStore(entries) {
  const normalized = sortEntries(
    (Array.isArray(entries) ? entries : [])
      .map((entry) => normalizeMaterializationEntry(entry))
      .filter(Boolean),
  );
  await mkdir(join(OC, "workspaces", "controller"), { recursive: true });
  await atomicWriteFile(SCHEDULE_MATERIALIZER_STORE, JSON.stringify({
    updatedAt: Date.now(),
    entries: normalized,
  }, null, 2));
  return normalized;
}

async function listMaterializationEntries() {
  const parsed = await readMaterializerStore();
  return sortEntries(
    (Array.isArray(parsed?.entries) ? parsed.entries : [])
      .map((entry) => normalizeMaterializationEntry(entry))
      .filter(Boolean),
  );
}

async function getScheduleMaterialization(scheduleId) {
  const normalizedId = normalizeString(scheduleId);
  if (!normalizedId) return null;
  const entries = await listMaterializationEntries();
  return entries.find((entry) => entry.scheduleId === normalizedId) || null;
}

async function upsertMaterializationEntry(entry) {
  const normalized = normalizeMaterializationEntry(entry);
  if (!normalized?.scheduleId) {
    throw new Error("invalid materialization entry");
  }
  return withLock(SCHEDULE_MATERIALIZER_STORE_LOCK, async () => {
    const entries = await listMaterializationEntries();
    const nextEntries = entries
      .filter((item) => item.scheduleId !== normalized.scheduleId)
      .concat(normalized);
    const saved = await writeMaterializerStore(nextEntries);
    return saved.find((item) => item.scheduleId === normalized.scheduleId) || null;
  });
}

async function clearScheduleMaterialization(scheduleId) {
  const normalizedId = normalizeString(scheduleId);
  if (!normalizedId) {
    throw new Error("missing schedule id");
  }
  return withLock(SCHEDULE_MATERIALIZER_STORE_LOCK, async () => {
    const entries = await listMaterializationEntries();
    const existing = entries.find((entry) => entry.scheduleId === normalizedId) || null;
    await writeMaterializerStore(entries.filter((entry) => entry.scheduleId !== normalizedId));
    return existing;
  });
}

function buildScheduleCronJobName(scheduleSpec) {
  return `watchdog schedule: ${normalizeString(scheduleSpec?.id) || "unknown"}`;
}

function buildAddArgs(scheduleSpec) {
  const trigger = normalizeRecord(scheduleSpec?.trigger, {});
  const targetAgent = normalizeString(scheduleSpec?.entry?.targetAgent);
  if (!targetAgent) {
    throw new Error("schedule entry.targetAgent is required");
  }

  const argv = [
    "openclaw",
    "cron",
    "add",
    ...buildGatewayCliArgs(),
    "--json",
    "--name",
    buildScheduleCronJobName(scheduleSpec),
    "--cron",
    String(trigger.expr || ""),
    "--session",
    "isolated",
    "--agent",
    targetAgent,
    "--message",
    buildScheduleTriggerCommandMessage(scheduleSpec.id),
    "--wake",
    "now",
    "--timeout-seconds",
    "30",
    "--light-context",
    "--no-deliver",
  ];

  const tz = normalizeString(trigger.tz);
  if (tz) {
    argv.push("--tz", tz);
  }
  if (scheduleSpec?.enabled !== true) {
    argv.push("--disabled");
  }
  return argv;
}

function buildEditArgs(scheduleSpec, jobId) {
  const trigger = normalizeRecord(scheduleSpec?.trigger, {});
  const targetAgent = normalizeString(scheduleSpec?.entry?.targetAgent);
  const normalizedJobId = normalizeString(jobId);
  if (!normalizedJobId) {
    throw new Error("missing cron job id");
  }
  if (!targetAgent) {
    throw new Error("schedule entry.targetAgent is required");
  }

  const argv = [
    "openclaw",
    "cron",
    "edit",
    normalizedJobId,
    ...buildGatewayCliArgs(),
    "--name",
    buildScheduleCronJobName(scheduleSpec),
    "--cron",
    String(trigger.expr || ""),
    "--session",
    "isolated",
    "--agent",
    targetAgent,
    "--message",
    buildScheduleTriggerCommandMessage(scheduleSpec.id),
    "--wake",
    "now",
    "--timeout-seconds",
    "30",
    "--light-context",
    "--no-deliver",
  ];

  const tz = normalizeString(trigger.tz);
  if (tz) {
    argv.push("--tz", tz);
  }
  argv.push(scheduleSpec?.enabled === true ? "--enable" : "--disable");
  return argv;
}

function buildRemoveArgs(jobId) {
  const normalizedJobId = normalizeString(jobId);
  if (!normalizedJobId) {
    throw new Error("missing cron job id");
  }
  return [
    "openclaw",
    "cron",
    "remove",
    normalizedJobId,
    ...buildGatewayCliArgs(),
    "--json",
  ];
}

function parseCronCliJson(stdout) {
  const raw = normalizeString(stdout);
  if (!raw) {
    throw new Error("cron command returned empty stdout");
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`cron command returned invalid json: ${error.message}`);
  }
}

function extractCronJobId(payload) {
  return normalizeString(payload?.id)
    || normalizeString(payload?.jobId)
    || normalizeString(payload?.job?.id)
    || normalizeString(payload?.data?.id)
    || null;
}

function isMissingCronJobError(message) {
  const normalized = String(message || "").toLowerCase();
  return normalized.includes("unknown cron job id")
    || normalized.includes("missing id")
    || normalized.includes("not found");
}

async function runCronCli(api, argv) {
  if (!api?.runtime?.system?.runCommandWithTimeout) {
    throw new Error("runtime.system.runCommandWithTimeout unavailable");
  }
  const result = await api.runtime.system.runCommandWithTimeout(argv, {
    timeoutMs: CRON_COMMAND_TIMEOUT_MS,
    cwd: OC,
  });
  if (result.code !== 0) {
    throw new Error((result.stderr || result.stdout || `cron command failed: ${result.code}`).trim());
  }
  return parseCronCliJson(result.stdout);
}

export async function syncScheduleMaterialization(scheduleSpec, {
  api,
  logger,
} = {}) {
  const scheduleId = normalizeString(scheduleSpec?.id);
  if (!scheduleId) {
    throw new Error("scheduleSpec.id is required");
  }

  const existing = await getScheduleMaterialization(scheduleId);
  const now = Date.now();

  try {
    let payload = null;
    let action = existing?.jobId ? "edit" : "add";

    if (action === "edit") {
      try {
        payload = await runCronCli(api, buildEditArgs(scheduleSpec, existing.jobId));
      } catch (error) {
        if (!isMissingCronJobError(error.message)) {
          throw error;
        }
        action = "add";
        payload = await runCronCli(api, buildAddArgs(scheduleSpec));
      }
    } else {
      payload = await runCronCli(api, buildAddArgs(scheduleSpec));
    }

    const jobId = extractCronJobId(payload);
    if (!jobId) {
      throw new Error("cron job id missing from gateway response");
    }

    const entry = await upsertMaterializationEntry({
      scheduleId,
      jobId,
      jobName: buildScheduleCronJobName(scheduleSpec),
      enabled: scheduleSpec.enabled === true,
      syncedAt: now,
      updatedAt: now,
      lastAction: action,
      lastError: null,
    });

    logger?.info?.(`[watchdog] schedule materialized: ${scheduleId} -> ${jobId} (${action})`);
    return {
      ok: true,
      action,
      jobId,
      payload,
      entry,
    };
  } catch (error) {
    await upsertMaterializationEntry({
      scheduleId,
      jobId: existing?.jobId || null,
      jobName: buildScheduleCronJobName(scheduleSpec),
      enabled: scheduleSpec.enabled === true,
      syncedAt: existing?.syncedAt || null,
      updatedAt: now,
      lastAction: existing?.jobId ? "edit_failed" : "add_failed",
      lastError: error.message,
    });
    throw error;
  }
}

export async function removeScheduleMaterialization(scheduleId, {
  api,
  logger,
} = {}) {
  const existing = await getScheduleMaterialization(scheduleId);
  if (!existing?.jobId) {
    await clearScheduleMaterialization(scheduleId);
    return {
      ok: true,
      removed: false,
      jobId: null,
    };
  }

  try {
    const payload = await runCronCli(api, buildRemoveArgs(existing.jobId));
    await clearScheduleMaterialization(scheduleId);
    logger?.info?.(`[watchdog] schedule materialization removed: ${scheduleId} -> ${existing.jobId}`);
    return {
      ok: true,
      removed: payload?.removed === true,
      jobId: existing.jobId,
      payload,
    };
  } catch (error) {
    if (!isMissingCronJobError(error.message)) {
      await upsertMaterializationEntry({
        ...existing,
        updatedAt: Date.now(),
        lastAction: "remove_failed",
        lastError: error.message,
      });
      throw error;
    }
    await clearScheduleMaterialization(scheduleId);
    return {
      ok: true,
      removed: false,
      jobId: existing.jobId,
      missing: true,
    };
  }
}
