import {
  buildHarnessSpec,
  finalizeHarnessRun,
  normalizeHarnessRun,
  normalizeHarnessSpec,
  startHarnessRun,
} from "../harness/harness-run.js";
import {
  finalizeHarnessRunModules,
  initializeHarnessRunModules,
} from "../harness/harness-module-runner.js";
import { normalizeRecord, normalizeString } from "../core/normalize.js";
import { isActiveContractStatus } from "../core/runtime-status.js";
import { buildAgentMainSessionKey } from "../session-keys.js";
import { normalizePositiveInteger } from "./automation-decision.js";

export function buildDefaultSystemActionDelivery(spec) {
  const targetAgent = normalizeString(spec?.systemActionDelivery?.agentId || spec?.entry?.targetAgent);
  if (!targetAgent) return null;
  return {
    agentId: targetAgent,
    sessionKey: normalizeString(spec?.systemActionDelivery?.sessionKey) || buildAgentMainSessionKey(targetAgent),
  };
}

export function buildAutomationContext(spec, round, trigger, ts, {
  harnessSpec = null,
  harnessRunId = null,
} = {}) {
  return {
    automationId: spec.id,
    round,
    trigger: normalizeString(trigger) || "manual",
    requestedAt: ts,
    executionMode: spec?.harness?.mode || "freeform",
    assuranceLevel: spec?.harness?.assuranceLevel || "low_assurance",
    objective: normalizeRecord(spec.objective, null),
    entry: normalizeRecord(spec.entry, null),
    adapters: normalizeRecord(spec.adapters, null),
    wakePolicy: normalizeRecord(spec.wakePolicy, null),
    governance: normalizeRecord(spec.governance, null),
    systemActionDelivery: normalizeRecord(spec.systemActionDelivery, null),
    harness: normalizeRecord(spec.harness, null),
    harnessSpec: normalizeRecord(harnessSpec, null),
    harnessRunId: normalizeString(harnessRunId) || null,
  };
}

export function isPipelineActive(pipeline) {
  return Boolean(pipeline?.currentStage && pipeline.currentStage !== "concluded");
}

export function resolveAutomationIdFromContext(value) {
  const context = normalizeRecord(value, null);
  if (!context) return null;
  return normalizeString(context.automationId || context.id);
}

export function resolveRoundFromContext(value, fallback = 0) {
  const context = normalizeRecord(value, null);
  if (!context) return fallback;
  return normalizePositiveInteger(context.round, fallback);
}

export function resolveTriggerFromContext(value, fallback = "manual") {
  const context = normalizeRecord(value, null);
  if (!context) return fallback;
  return normalizeString(context.trigger)?.toLowerCase() || fallback;
}

export function resolveRequestedAtFromContext(value, fallback = Date.now()) {
  const context = normalizeRecord(value, null);
  if (!context) return fallback;
  return Number.isFinite(context.requestedAt) ? context.requestedAt : fallback;
}

function selectLatestContract(left, right) {
  const leftTs = Number(left?.updatedAt) || Number(left?.createdAt) || 0;
  const rightTs = Number(right?.updatedAt) || Number(right?.createdAt) || 0;
  return leftTs >= rightTs ? left : right;
}

export function buildContractIndex(contracts) {
  const byId = new Map();
  const activeByAutomationId = new Map();

  for (const contract of Array.isArray(contracts) ? contracts : []) {
    const contractId = normalizeString(contract?.id);
    if (contractId) {
      byId.set(contractId, contract);
    }

    if (!isActiveContractStatus(contract?.status)) continue;
    const automationId = resolveAutomationIdFromContext(contract?.automationContext);
    if (!automationId) continue;

    const existing = activeByAutomationId.get(automationId);
    activeByAutomationId.set(
      automationId,
      existing ? selectLatestContract(existing, contract) : contract,
    );
  }

  return { byId, activeByAutomationId };
}

export function hasRecordedRound(runtime, round) {
  return (Array.isArray(runtime?.recentRounds) ? runtime.recentRounds : [])
    .some((entry) => Number(entry?.round) === Number(round));
}

function sortHarnessRuns(runs) {
  return [...(Array.isArray(runs) ? runs : [])]
    .sort((left, right) => {
      const leftTs = Number(left?.finalizedAt) || Number(left?.startedAt) || 0;
      const rightTs = Number(right?.finalizedAt) || Number(right?.startedAt) || 0;
      if (rightTs !== leftTs) return rightTs - leftTs;
      return Number(right?.round || 0) - Number(left?.round || 0);
    });
}

export function appendHarnessRun(runtime, harnessRun) {
  const normalized = normalizeHarnessRun(harnessRun);
  if (!normalized) {
    return sortHarnessRuns(Array.isArray(runtime?.recentHarnessRuns) ? runtime.recentHarnessRuns : []).slice(0, 20);
  }

  return sortHarnessRuns([
    normalized,
    ...((Array.isArray(runtime?.recentHarnessRuns) ? runtime.recentHarnessRuns : [])
      .filter((entry) => (
        normalizeString(entry?.id) !== normalized.id
        && Number(entry?.round) !== normalized.round
      ))),
  ]).slice(0, 20);
}

export async function buildActiveHarnessLifecycle(spec, runtime, {
  round,
  trigger = "manual",
  requestedAt = Date.now(),
  startedAt = requestedAt,
  contractId = null,
  pipelineId = null,
  loopId = null,
} = {}) {
  const normalizedRound = normalizePositiveInteger(round, 0);
  if (!normalizedRound) {
    return {
      activeHarnessSpec: null,
      activeHarnessRun: null,
    };
  }

  const currentSpec = normalizeHarnessSpec(runtime?.activeHarnessSpec);
  const currentRun = normalizeHarnessRun(runtime?.activeHarnessRun);
  const sameRound = Number(currentRun?.round || currentSpec?.round || 0) === normalizedRound;
  const normalizedTrigger = normalizeString(trigger)?.toLowerCase() || "manual";
  const normalizedRequestedAt = Number.isFinite(requestedAt) ? requestedAt : Date.now();
  const normalizedStartedAt = Number.isFinite(startedAt) ? startedAt : normalizedRequestedAt;

  const nextSpec = sameRound && currentSpec
    ? normalizeHarnessSpec({
      ...buildHarnessSpec(spec, {
        round: normalizedRound,
        trigger: currentSpec?.trigger || normalizedTrigger,
        requestedAt: currentSpec?.requestedAt || normalizedRequestedAt,
      }),
      ...currentSpec,
      round: normalizedRound,
      trigger: currentSpec?.trigger || normalizedTrigger,
      requestedAt: currentSpec?.requestedAt || normalizedRequestedAt,
    })
    : buildHarnessSpec(spec, {
      round: normalizedRound,
      trigger: normalizedTrigger,
      requestedAt: normalizedRequestedAt,
    });

  const nextRun = sameRound && currentRun
    ? normalizeHarnessRun({
      ...currentRun,
      ...nextSpec,
      status: "running",
      startedAt: Number.isFinite(currentRun?.startedAt) ? currentRun.startedAt : normalizedStartedAt,
      contractId: contractId || currentRun?.contractId || null,
      pipelineId: pipelineId || currentRun?.pipelineId || null,
      loopId: loopId || currentRun?.loopId || null,
    })
    : startHarnessRun(nextSpec, {
      startedAt: normalizedStartedAt,
      contractId,
      pipelineId,
      loopId,
    });
  const initializedRun = await initializeHarnessRunModules(nextRun, {
    automationSpec: spec,
  });

  return {
    activeHarnessSpec: nextSpec,
    activeHarnessRun: initializedRun,
  };
}

export function classifyStartResult(triggerResult) {
  const source = normalizeRecord(triggerResult, {});
  const contractId = normalizeString(source.contractId) || null;
  const pipelineId = normalizeString(source.pipelineId) || null;
  const loopId = normalizeString(source.loopId) || null;
  const loopSessionId = normalizeString(source.loopSessionId) || null;
  const pipelineAction = normalizeString(source.pipelineAction || source.action)?.toLowerCase() || null;
  const started = Boolean(contractId || pipelineId || pipelineAction === "started");
  const busy = pipelineAction === "busy" || source.reason === "pipeline_busy";
  return {
    started,
    busy,
    reason: busy ? "pipeline_busy" : (source.reason || pipelineAction || "not_started"),
    contractId,
    pipelineId,
    loopId,
    loopSessionId,
    pipelineAction,
  };
}

export function ensureRuntimeContext({
  api,
  enqueue,
  wakePlanner,
}) {
  if (!api || typeof enqueue !== "function" || typeof wakePlanner !== "function") {
    throw new Error("missing runtime context for automation executor");
  }
}
