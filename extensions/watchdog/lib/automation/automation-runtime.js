import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { listAutomationSpecs } from "./automation-registry.js";
import { projectAutomationHarnessSummary } from "./automation-harness-projection.js";
import { normalizeReviewerResult } from "../harness/reviewer-result.js";
import { normalizeHarnessRun, normalizeHarnessSpec } from "../harness/harness-run.js";
import { normalizeEnum, normalizeFiniteNumber, normalizePositiveInteger, normalizeRecord, normalizeString, uniqueStrings } from "../core/normalize.js";
import { OC, atomicWriteFile, withLock } from "../state.js";

export const AUTOMATION_RUNTIME_STORE = join(OC, "workspaces", "controller", ".watchdog-automation-runtime.json");
const AUTOMATION_RUNTIME_STORE_LOCK = "store:automation-runtime";

const VALID_AUTOMATION_RUNTIME_STATUSES = new Set([
  "idle",
  "running",
  "paused",
  "completed",
  "stopped",
  "error",
]);

function normalizeAutomationRuntimeStatus(value, fallback = "idle") {
  return normalizeEnum(value, VALID_AUTOMATION_RUNTIME_STATUSES, fallback);
}

function normalizeAutomationDecision(value) {
  const source = normalizeRecord(value, null);
  if (!source) return null;
  const decision = normalizeString(source.decision)?.toLowerCase();
  if (!decision) return null;
  return {
    action: normalizeString(source.action)?.toLowerCase() || decision,
    decision,
    status: normalizeString(source.status)?.toLowerCase() || null,
    reason: normalizeString(source.reason) || null,
    round: Number.isFinite(source.round) ? source.round : null,
    score: normalizeFiniteNumber(source.score, null),
    verdict: normalizeString(source.verdict) || null,
    improvementState: normalizeRecord(source.improvementState, null),
    reworkGuidance: normalizeRecord(source.reworkGuidance, null),
    nextWakeAt: Number.isFinite(source.nextWakeAt) ? source.nextWakeAt : null,
    ts: Number.isFinite(source.ts) ? source.ts : null,
  };
}

function normalizeRoundSummary(value) {
  const source = normalizeRecord(value, null);
  if (!source) return null;

  const round = normalizePositiveInteger(source.round, -1);
  if (round < 0) return null;

  return {
    round,
    score: normalizeFiniteNumber(source.score, null),
    decision: normalizeString(source.decision)?.toLowerCase() || null,
    status: normalizeString(source.status)?.toLowerCase() || null,
    artifact: normalizeString(source.artifact || source.output || source.path) || null,
    summary: normalizeString(source.summary) || null,
    ts: Number.isFinite(source.ts) ? source.ts : null,
  };
}

function buildDefaultRuntimeState(automationSpec) {
  const automationId = normalizeString(automationSpec?.id);
  if (!automationId) {
    throw new Error("automationSpec.id is required");
  }

  const now = Date.now();
  return {
    automationId,
    status: automationSpec?.enabled === false ? "paused" : "idle",
    currentRound: 0,
    activeContractId: null,
    activeLoopId: null,
    activePipelineId: null,
    lastWakeAt: null,
    nextWakeAt: null,
    lastResultAt: null,
    bestRound: null,
    bestScore: null,
    bestArtifact: null,
    lastScore: null,
    noImprovementStreak: 0,
    childAutomationIds: [],
    recentRounds: [],
    activeHarnessSpec: null,
    activeHarnessRun: null,
    lastHarnessRun: null,
    lastReviewerResult: null,
    lastAutomationDecision: null,
    recentHarnessRuns: [],
    createdAt: now,
    updatedAt: now,
  };
}

function normalizeAutomationRuntimeState(value) {
  const source = normalizeRecord(value, null);
  if (!source) return null;

  const automationId = normalizeString(source.automationId || source.id);
  if (!automationId) return null;

  return {
    automationId,
    status: normalizeAutomationRuntimeStatus(source.status),
    currentRound: normalizePositiveInteger(source.currentRound, 0),
    activeContractId: normalizeString(source.activeContractId) || null,
    activeLoopId: normalizeString(source.activeLoopId) || null,
    activePipelineId: normalizeString(source.activePipelineId) || null,
    lastWakeAt: Number.isFinite(source.lastWakeAt) ? source.lastWakeAt : null,
    nextWakeAt: Number.isFinite(source.nextWakeAt) ? source.nextWakeAt : null,
    lastResultAt: Number.isFinite(source.lastResultAt) ? source.lastResultAt : null,
    bestRound: Number.isFinite(source.bestRound) ? source.bestRound : null,
    bestScore: normalizeFiniteNumber(source.bestScore, null),
    bestArtifact: normalizeString(source.bestArtifact) || null,
    lastScore: normalizeFiniteNumber(source.lastScore, null),
    noImprovementStreak: normalizePositiveInteger(source.noImprovementStreak, 0),
    childAutomationIds: uniqueStrings(source.childAutomationIds),
    recentRounds: (Array.isArray(source.recentRounds) ? source.recentRounds : [])
      .map((entry) => normalizeRoundSummary(entry))
      .filter(Boolean)
      .sort((left, right) => right.round - left.round)
      .slice(0, 20),
    activeHarnessSpec: normalizeHarnessSpec(source.activeHarnessSpec),
    activeHarnessRun: normalizeHarnessRun(source.activeHarnessRun),
    lastHarnessRun: normalizeHarnessRun(source.lastHarnessRun),
    lastReviewerResult: normalizeReviewerResult(source.lastReviewerResult),
    lastAutomationDecision: normalizeAutomationDecision(source.lastAutomationDecision),
    recentHarnessRuns: (Array.isArray(source.recentHarnessRuns) ? source.recentHarnessRuns : [])
      .map((entry) => normalizeHarnessRun(entry))
      .filter(Boolean)
      .sort((left, right) => {
        const leftTs = Number(left?.finalizedAt) || Number(left?.startedAt) || 0;
        const rightTs = Number(right?.finalizedAt) || Number(right?.startedAt) || 0;
        if (rightTs !== leftTs) return rightTs - leftTs;
        return Number(right?.round || 0) - Number(left?.round || 0);
      })
      .slice(0, 20),
    createdAt: Number.isFinite(source.createdAt) ? source.createdAt : null,
    updatedAt: Number.isFinite(source.updatedAt) ? source.updatedAt : null,
  };
}

async function readAutomationRuntimeStore() {
  try {
    return JSON.parse(await readFile(AUTOMATION_RUNTIME_STORE, "utf8"));
  } catch {
    return {};
  }
}

function sortAutomationRuntimeStates(states) {
  return [...(Array.isArray(states) ? states : [])]
    .sort((left, right) => String(left?.automationId || "").localeCompare(String(right?.automationId || "")));
}

async function writeAutomationRuntimeStore(states) {
  const normalized = sortAutomationRuntimeStates(
    (Array.isArray(states) ? states : [])
      .map((entry) => normalizeAutomationRuntimeState(entry))
      .filter(Boolean),
  );
  await mkdir(join(OC, "workspaces", "controller"), { recursive: true });
  await atomicWriteFile(AUTOMATION_RUNTIME_STORE, JSON.stringify({
    updatedAt: Date.now(),
    states: normalized,
  }, null, 2));
  return normalized;
}

export async function listAutomationRuntimeStates() {
  const parsed = await readAutomationRuntimeStore();
  return sortAutomationRuntimeStates(
    (Array.isArray(parsed?.states) ? parsed.states : [])
      .map((entry) => normalizeAutomationRuntimeState(entry))
      .filter(Boolean),
  );
}

export async function getAutomationRuntimeState(automationId) {
  const normalizedId = normalizeString(automationId);
  if (!normalizedId) return null;
  const states = await listAutomationRuntimeStates();
  return states.find((entry) => entry.automationId === normalizedId) || null;
}

export async function ensureAutomationRuntimeState(automationSpec) {
  return withLock(AUTOMATION_RUNTIME_STORE_LOCK, async () => {
    const existing = await getAutomationRuntimeState(automationSpec?.id);
    if (existing) return existing;

    const defaults = buildDefaultRuntimeState(automationSpec);
    const states = await listAutomationRuntimeStates();
    const saved = await writeAutomationRuntimeStore(states.concat(defaults));
    return saved.find((entry) => entry.automationId === defaults.automationId) || null;
  });
}

export async function upsertAutomationRuntimeState(runtimeState) {
  const normalized = normalizeAutomationRuntimeState(runtimeState);
  if (!normalized?.automationId) {
    throw new Error("invalid automation runtime state");
  }

  return withLock(AUTOMATION_RUNTIME_STORE_LOCK, async () => {
    const now = Date.now();
    const states = await listAutomationRuntimeStates();
    const existing = states.find((entry) => entry.automationId === normalized.automationId) || null;
    const nextStates = states
      .filter((entry) => entry.automationId !== normalized.automationId)
      .concat({
        ...normalized,
        createdAt: Number.isFinite(existing?.createdAt) ? existing.createdAt : now,
        updatedAt: now,
      });
    const saved = await writeAutomationRuntimeStore(nextStates);
    return saved.find((entry) => entry.automationId === normalized.automationId) || null;
  });
}

export async function setAutomationRuntimeStatus(automationId, status, {
  nextWakeAt = undefined,
} = {}) {
  const normalizedId = normalizeString(automationId);
  if (!normalizedId) {
    throw new Error("missing automation id");
  }

  return withLock(AUTOMATION_RUNTIME_STORE_LOCK, async () => {
    const now = Date.now();
    const states = await listAutomationRuntimeStates();
    const existing = states.find((entry) => entry.automationId === normalizedId) || null;
    if (!existing) {
      throw new Error(`unknown automation runtime id: ${normalizedId}`);
    }

    const nextStates = states
      .filter((entry) => entry.automationId !== normalizedId)
      .concat({
        ...existing,
        status: normalizeAutomationRuntimeStatus(status, existing.status),
        ...(nextWakeAt !== undefined ? { nextWakeAt } : {}),
        createdAt: Number.isFinite(existing?.createdAt) ? existing.createdAt : now,
        updatedAt: now,
      });
    const saved = await writeAutomationRuntimeStore(nextStates);
    return saved.find((entry) => entry.automationId === normalizedId) || null;
  });
}

export async function deleteAutomationRuntimeState(automationId) {
  const normalizedId = normalizeString(automationId);
  if (!normalizedId) {
    throw new Error("missing automation id");
  }

  return withLock(AUTOMATION_RUNTIME_STORE_LOCK, async () => {
    const states = await listAutomationRuntimeStates();
    const existing = states.find((entry) => entry.automationId === normalizedId) || null;
    if (!existing) {
      return {
        ok: true,
        deleted: false,
        runtime: null,
      };
    }

    await writeAutomationRuntimeStore(states.filter((entry) => entry.automationId !== normalizedId));
    return {
      ok: true,
      deleted: true,
      runtime: existing,
    };
  });
}

function summarizeAutomationInstance(spec, runtime) {
  const harnessSummary = projectAutomationHarnessSummary({
    harness: spec?.harness,
    runtime,
  });
  return {
    id: spec.id,
    enabled: spec.enabled === true,
    objectiveSummary: spec.objective?.summary || null,
    objectiveDomain: spec.objective?.domain || spec.adapters?.domain || null,
    targetAgent: spec.entry?.targetAgent || null,
    routeHint: spec.entry?.routeHint || null,
    wakeType: spec.wakePolicy?.type || null,
    wakeScheduleId: spec.wakePolicy?.scheduleId || null,
    runtimeStatus: runtime?.status || (spec.enabled === true ? "idle" : "paused"),
    currentRound: Number.isFinite(runtime?.currentRound) ? runtime.currentRound : 0,
    bestScore: runtime?.bestScore ?? null,
    activeContractId: runtime?.activeContractId || null,
    activeLoopId: runtime?.activeLoopId || null,
    nextWakeAt: runtime?.nextWakeAt || null,
    childAutomationCount: Array.isArray(runtime?.childAutomationIds) ? runtime.childAutomationIds.length : 0,
    ...harnessSummary,
    governance: spec.governance,
  };
}

export async function summarizeAutomationRuntimeRegistry({
  enabled = null,
  status = null,
} = {}) {
  const [automations, runtimeStates] = await Promise.all([
    listAutomationSpecs({ enabled }),
    listAutomationRuntimeStates(),
  ]);
  const runtimeById = new Map(runtimeStates.map((entry) => [entry.automationId, entry]));
  const entries = automations
    .map((automation) => ({
      ...automation,
      runtime: runtimeById.get(automation.id) || buildDefaultRuntimeState(automation),
    }))
    .filter((entry) => (
      status
        ? entry.runtime?.status === normalizeAutomationRuntimeStatus(status, entry.runtime?.status)
        : true
    ))
    .sort((left, right) => (right.updatedAt || 0) - (left.updatedAt || 0));
  const summarizedEntries = entries.map((entry) => ({
    ...entry,
    summary: summarizeAutomationInstance(entry, entry.runtime),
  }));
  const resolveHarnessVerdict = (entry) => (
    entry?.summary?.activeHarnessGateVerdict
    || entry?.summary?.lastHarnessGateVerdict
    || "none"
  );

  return {
    automations: summarizedEntries,
    counts: {
      total: summarizedEntries.length,
      enabled: summarizedEntries.filter((entry) => entry.enabled === true).length,
      disabled: summarizedEntries.filter((entry) => entry.enabled !== true).length,
      idle: summarizedEntries.filter((entry) => entry.runtime?.status === "idle").length,
      running: summarizedEntries.filter((entry) => entry.runtime?.status === "running").length,
      paused: summarizedEntries.filter((entry) => entry.runtime?.status === "paused").length,
      completed: summarizedEntries.filter((entry) => entry.runtime?.status === "completed").length,
      error: summarizedEntries.filter((entry) => entry.runtime?.status === "error").length,
      byExecutionMode: {
        freeform: summarizedEntries.filter((entry) => entry.summary?.executionMode === "freeform").length,
        hybrid: summarizedEntries.filter((entry) => entry.summary?.executionMode === "hybrid").length,
        guarded: summarizedEntries.filter((entry) => entry.summary?.executionMode === "guarded").length,
      },
      byHarnessGateVerdict: {
        none: summarizedEntries.filter((entry) => resolveHarnessVerdict(entry) === "none").length,
        pending: summarizedEntries.filter((entry) => resolveHarnessVerdict(entry) === "pending").length,
        passed: summarizedEntries.filter((entry) => resolveHarnessVerdict(entry) === "passed").length,
        failed: summarizedEntries.filter((entry) => resolveHarnessVerdict(entry) === "failed").length,
      },
      activeHarnessRuns: summarizedEntries.filter((entry) => Boolean(entry.summary?.activeHarnessRunId)).length,
      pendingHarnessAutomations: summarizedEntries.filter((entry) => (
        entry.summary?.activeHarnessGateVerdict === "pending"
        || (entry.summary?.activeHarnessPendingModuleCount || 0) > 0
      )).length,
      failingHarnessAutomations: summarizedEntries.filter((entry) => (
        (entry.summary?.activeHarnessFailedModuleCount || 0) > 0
        || (entry.summary?.lastHarnessFailedModuleCount || 0) > 0
      )).length,
      pendingHarnessModules: summarizedEntries
        .reduce((total, entry) => total + (entry.summary?.activeHarnessPendingModuleCount || 0), 0),
      failedHarnessModules: summarizedEntries
        .reduce((total, entry) => total + Math.max(
          entry.summary?.activeHarnessFailedModuleCount || 0,
          entry.summary?.lastHarnessFailedModuleCount || 0,
        ), 0),
      recentHarnessRuns: summarizedEntries.filter((entry) => (entry.summary?.recentHarnessRunCount || 0) > 0).length,
    },
  };
}
