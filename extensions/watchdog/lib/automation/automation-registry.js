import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { normalizeBoolean, normalizeFiniteNumber, normalizePositiveInteger, normalizeRecord, normalizeString } from "../core/normalize.js";
import { normalizeDeliveryTargets } from "../routing/delivery-targets.js";
import { normalizeHarnessSelection } from "../harness/harness-registry.js";
import { OC, atomicWriteFile, withLock } from "../state.js";
import { buildAgentMainSessionKey } from "../session-keys.js";

export const AUTOMATION_STORE = join(OC, "workspaces", "controller", ".watchdog-automations.json");
const AUTOMATION_STORE_LOCK = "store:automation-specs";

const DEFAULT_WAKE_COOLDOWN_SECONDS = 300;
const DEFAULT_GOVERNANCE_BATCH_SIZE = 10;
const DEFAULT_GOVERNANCE_CHECKPOINT_EVERY = 5;
const DEFAULT_GOVERNANCE_EARLY_STOP_PATIENCE = 10;

function normalizeAutomationObjective(value) {
  const source = normalizeRecord(value, null);
  if (!source) return null;

  const summary = normalizeString(
    source.summary
    || source.goal
    || source.description
    || source.objective,
  );
  const instruction = normalizeString(
    source.instruction
    || source.message
    || source.task
    || summary,
  );

  if (!summary || !instruction) return null;

  return {
    summary,
    instruction,
    domain: normalizeString(source.domain) || "generic",
    successSignal: normalizeString(source.successSignal || source.successCriteria) || null,
  };
}

function normalizeAutomationEntry(value, objective) {
  const source = normalizeRecord(value, {});
  const targetAgent = normalizeString(source.targetAgent || source.agentId) || "controller";
  const message = normalizeString(source.message || source.instruction || objective?.instruction);
  if (!message) return null;

  return {
    type: normalizeString(source.type)?.toLowerCase() || "workflow",
    targetAgent,
    message,
    routeHint: normalizeString(source.routeHint) || null,
  };
}

function normalizeAutomationSystemActionDelivery(value, entry) {
  const source = normalizeRecord(value, null);
  const agentId = normalizeString(source?.agentId) || normalizeString(entry?.targetAgent);
  if (!agentId) return null;

  return {
    agentId,
    sessionKey: normalizeString(source?.sessionKey) || buildAgentMainSessionKey(agentId),
  };
}

function normalizeWakePolicy(value) {
  const source = normalizeRecord(value, {});
  const type = normalizeString(source.type || source.kind || source.mode)?.toLowerCase() || "manual";
  return {
    type,
    scheduleId: normalizeString(source.scheduleId) || null,
    cooldownSeconds: normalizePositiveInteger(source.cooldownSeconds, DEFAULT_WAKE_COOLDOWN_SECONDS),
    onBoot: normalizeBoolean(source.onBoot),
    onResult: source.onResult == null
      ? ["hybrid", "event", "result"].includes(type)
      : normalizeBoolean(source.onResult),
    onFailure: normalizeBoolean(source.onFailure),
  };
}

function normalizeGovernance(value) {
  const source = normalizeRecord(value, {});
  return {
    mode: normalizeString(source.mode)?.toLowerCase() || "continuous",
    maxRounds: normalizePositiveInteger(source.maxRounds, null),
    batchSize: normalizePositiveInteger(source.batchSize, DEFAULT_GOVERNANCE_BATCH_SIZE),
    checkpointEvery: normalizePositiveInteger(source.checkpointEvery, DEFAULT_GOVERNANCE_CHECKPOINT_EVERY),
    earlyStopPatience: normalizePositiveInteger(source.earlyStopPatience, DEFAULT_GOVERNANCE_EARLY_STOP_PATIENCE),
    minImprovement: normalizeFiniteNumber(source.minImprovement, 0),
    allowChildAutomations: normalizeBoolean(source.allowChildAutomations),
    maxChildAutomations: normalizePositiveInteger(source.maxChildAutomations, 0) || 0,
    budgetSeconds: normalizePositiveInteger(source.budgetSeconds, null),
  };
}

function normalizeAutomationAdapters(value, objective) {
  const source = normalizeRecord(value, {});
  return {
    domain: normalizeString(source.domain || objective?.domain) || "generic",
    executor: normalizeString(source.executor || source.execution) || null,
    reviewer: normalizeString(source.evaluator || source.evaluation) || null,
  };
}

function normalizeAutomationHarness(value) {
  return normalizeHarnessSelection(value);
}

export function normalizeAutomationSpec(value) {
  const source = normalizeRecord(value, null);
  if (!source) return null;

  const id = normalizeString(source.id || source.name);
  const objective = normalizeAutomationObjective({
    ...(normalizeRecord(source.objective, {})),
    ...(normalizeString(source.summary || source.goal || source.description)
      ? { summary: source.summary || source.goal || source.description }
      : {}),
    ...(normalizeString(source.instruction || source.message || source.task)
      ? { instruction: source.instruction || source.message || source.task }
      : {}),
    ...(normalizeString(source.domain) ? { domain: source.domain } : {}),
    ...(normalizeString(source.successSignal || source.successCriteria)
      ? { successSignal: source.successSignal || source.successCriteria }
      : {}),
  });
  const entry = normalizeAutomationEntry({
    ...(normalizeRecord(source.entry, {})),
    ...(normalizeString(source.targetAgent || source.agentId)
      ? { targetAgent: source.targetAgent || source.agentId }
      : {}),
    ...(normalizeString(source.routeHint) ? { routeHint: source.routeHint } : {}),
  }, objective);
  const harness = normalizeAutomationHarness({
    ...(normalizeRecord(source.harness, {})),
    ...(normalizeString(source.executionMode) ? { mode: source.executionMode } : {}),
    ...(normalizeString(source.assuranceLevel) ? { assuranceLevel: source.assuranceLevel } : {}),
    ...(normalizeString(source.harnessProfile || source.harnessProfileId || source.profileId)
      ? { profileId: source.harnessProfile || source.harnessProfileId || source.profileId }
      : {}),
    ...(normalizeRecord(source.harnessCoverage, null)
      ? { coverage: source.harnessCoverage }
      : {}),
  });

  if (!id || !objective || !entry || !harness) return null;

  return {
    id,
    enabled: source.enabled == null ? true : normalizeBoolean(source.enabled),
    objective,
    entry,
    adapters: normalizeAutomationAdapters(source.adapters, objective),
    wakePolicy: normalizeWakePolicy(source.wakePolicy),
    governance: normalizeGovernance(source.governance),
    systemActionDelivery: normalizeAutomationSystemActionDelivery(source.systemActionDelivery, entry),
    harness,
    deliveryTargets: normalizeDeliveryTargets(source.deliveryTargets || []),
    createdAt: Number.isFinite(source.createdAt) ? source.createdAt : null,
    updatedAt: Number.isFinite(source.updatedAt) ? source.updatedAt : null,
  };
}

async function readAutomationStore() {
  try {
    return JSON.parse(await readFile(AUTOMATION_STORE, "utf8"));
  } catch {
    return {};
  }
}

function sortAutomations(automations) {
  return [...(Array.isArray(automations) ? automations : [])]
    .sort((left, right) => String(left?.id || "").localeCompare(String(right?.id || "")));
}

async function writeAutomationStore(automations) {
  const normalized = sortAutomations(
    (Array.isArray(automations) ? automations : [])
      .map((entry) => normalizeAutomationSpec(entry))
      .filter(Boolean),
  );
  const now = Date.now();
  await mkdir(join(OC, "workspaces", "controller"), { recursive: true });
  await atomicWriteFile(AUTOMATION_STORE, JSON.stringify({
    updatedAt: now,
    automations: normalized,
  }, null, 2));
  return normalized;
}

export async function listAutomationSpecs({
  enabled = null,
} = {}) {
  const parsed = await readAutomationStore();
  const entries = Array.isArray(parsed?.automations) ? parsed.automations : [];
  return sortAutomations(entries
    .map((entry) => normalizeAutomationSpec(entry))
    .filter(Boolean)
    .filter((entry) => (typeof enabled === "boolean" ? entry.enabled === enabled : true)));
}

export async function getAutomationSpec(automationId) {
  const normalizedId = normalizeString(automationId);
  if (!normalizedId) return null;
  const automations = await listAutomationSpecs();
  return automations.find((entry) => entry.id === normalizedId) || null;
}

export async function upsertAutomationSpec(automationSpec) {
  const normalized = normalizeAutomationSpec(automationSpec);
  if (!normalized?.id) {
    throw new Error("invalid automation spec");
  }

  return withLock(AUTOMATION_STORE_LOCK, async () => {
    const now = Date.now();
    const automations = await listAutomationSpecs();
    const existing = automations.find((entry) => entry.id === normalized.id) || null;
    const nextAutomations = automations
      .filter((entry) => entry.id !== normalized.id)
      .concat({
        ...normalized,
        createdAt: Number.isFinite(existing?.createdAt) ? existing.createdAt : now,
        updatedAt: now,
      });
    const saved = await writeAutomationStore(nextAutomations);
    return saved.find((entry) => entry.id === normalized.id) || null;
  });
}

export async function setAutomationEnabled(automationId, enabled) {
  const normalizedId = normalizeString(automationId);
  if (!normalizedId) {
    throw new Error("missing automation id");
  }

  return withLock(AUTOMATION_STORE_LOCK, async () => {
    const now = Date.now();
    const automations = await listAutomationSpecs();
    const existing = automations.find((entry) => entry.id === normalizedId) || null;
    if (!existing) {
      throw new Error(`unknown automation id: ${normalizedId}`);
    }

    const nextAutomations = automations
      .filter((entry) => entry.id !== normalizedId)
      .concat({
        ...existing,
        enabled: enabled === true,
        createdAt: Number.isFinite(existing?.createdAt) ? existing.createdAt : now,
        updatedAt: now,
      });
    const saved = await writeAutomationStore(nextAutomations);
    return saved.find((entry) => entry.id === normalizedId) || null;
  });
}

export async function deleteAutomationSpec(automationId) {
  const normalizedId = normalizeString(automationId);
  if (!normalizedId) {
    throw new Error("missing automation id");
  }

  return withLock(AUTOMATION_STORE_LOCK, async () => {
    const automations = await listAutomationSpecs();
    const existing = automations.find((entry) => entry.id === normalizedId) || null;
    if (!existing) {
      return {
        ok: true,
        deleted: false,
        automation: null,
      };
    }

    await writeAutomationStore(automations.filter((entry) => entry.id !== normalizedId));
    return {
      ok: true,
      deleted: true,
      automation: existing,
    };
  });
}
