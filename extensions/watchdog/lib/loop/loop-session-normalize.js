import { randomBytes } from "node:crypto";
import { normalizeRecord, normalizeString, uniqueStrings } from "../core/normalize.js";
import { DEFAULT_LOOP_MAX_ROUNDS, DEFAULT_LOOP_MAX_EXPERIMENTS } from "./loop-budget.js";

const MAX_RECENT_LOOP_SESSIONS = 20;

export function normalizeTransition(value) {
  const record = normalizeRecord(value, null);
  if (!record) {
    return null;
  }

  const from = normalizeString(record.from);
  const to = normalizeString(record.to);
  if (!from || !to) {
    return null;
  }

  return {
    from,
    to,
    ts: Number.isFinite(record.ts) ? record.ts : Date.now(),
    feedback: normalizeString(record.feedback) || null,
  };
}

export function normalizeLoopSessionEntry(value) {
  const record = normalizeRecord(value, null);
  if (!record) {
    return null;
  }

  const id = normalizeString(record.id);
  if (!id) {
    return null;
  }

  const nodes = uniqueStrings(record.nodes);
  const phaseOrder = uniqueStrings(record.phaseOrder);

  const budget = normalizeRecord(record.budget, null);

  return {
    id,
    loopId: normalizeString(record.loopId) || null,
    pipelineId: normalizeString(record.pipelineId) || null,
    kind: normalizeString(record.kind) || null,
    entryAgentId: normalizeString(record.entryAgentId) || nodes[0] || null,
    startAgentId: normalizeString(record.startAgentId) || normalizeString(record.entryAgentId) || nodes[0] || null,
    currentStage: normalizeString(record.currentStage) || null,
    previousStage: normalizeString(record.previousStage) || null,
    round: Number.isFinite(record.round) ? record.round : 1,
    status: normalizeString(record.status) || "active",
    nodes,
    phaseOrder,
    transitionCount: Number.isFinite(record.transitionCount) ? record.transitionCount : 0,
    lastTransition: normalizeTransition(record.lastTransition),
    startedAt: Number.isFinite(record.startedAt) ? record.startedAt : Date.now(),
    updatedAt: Number.isFinite(record.updatedAt) ? record.updatedAt : Date.now(),
    concludedAt: Number.isFinite(record.concludedAt) ? record.concludedAt : null,
    concludeReason: normalizeString(record.concludeReason) || null,
    metadata: normalizeRecord(record.metadata, null),

    // P0: loop-own operational state (comms fields stay on contract)
    budget: budget ? {
      maxRounds: Number.isFinite(budget.maxRounds) ? budget.maxRounds : DEFAULT_LOOP_MAX_ROUNDS,
      maxExperiments: Number.isFinite(budget.maxExperiments) ? budget.maxExperiments : DEFAULT_LOOP_MAX_EXPERIMENTS,
      usedRounds: Number.isFinite(budget.usedRounds) ? budget.usedRounds : 0,
      usedExperiments: Number.isFinite(budget.usedExperiments) ? budget.usedExperiments : 0,
    } : null,
    deadEnds: uniqueStrings(record.deadEnds),
    feedbackOutput: normalizeRecord(record.feedbackOutput, null),
    stageHistory: Array.isArray(record.stageHistory) ? record.stageHistory : [],
    conclusionArtifact: normalizeString(record.conclusionArtifact) || null,
    requestedTask: normalizeString(record.requestedTask) || null,
    requestedSource: normalizeString(record.requestedSource) || null,
    taskStagePlan: normalizeRecord(record.taskStagePlan, null),
    taskStageRuntime: normalizeRecord(record.taskStageRuntime, null),
    semanticStageMode: normalizeString(record.semanticStageMode) || null,
    pendingSoftGate: normalizeRecord(record.pendingSoftGate, null),
    interruptedStage: normalizeString(record.interruptedStage) || null,
    resumeFromLoopSessionId: normalizeString(record.resumeFromLoopSessionId) || null,
    resumeReason: normalizeString(record.resumeReason) || null,
  };
}

export function buildDefaultLoopSessionState() {
  return {
    activeSession: null,
    recentSessions: [],
  };
}

export function normalizeLoopSessionState(value) {
  const record = normalizeRecord(value, null);
  const activeSession = normalizeLoopSessionEntry(record?.activeSession);
  const recentSessions = (Array.isArray(record?.recentSessions) ? record.recentSessions : [])
    .map((entry) => normalizeLoopSessionEntry(entry))
    .filter(Boolean)
    .filter((entry, index, array) => array.findIndex((candidate) => candidate.id === entry.id) === index)
    .slice(0, MAX_RECENT_LOOP_SESSIONS);

  return {
    activeSession,
    recentSessions: activeSession
      ? recentSessions.filter((entry) => entry.id !== activeSession.id)
      : recentSessions,
  };
}

export function archiveLoopSession(state, session) {
  const normalized = normalizeLoopSessionEntry(session);
  if (!normalized) {
    state.activeSession = null;
    return state;
  }

  state.activeSession = null;
  state.recentSessions = [
    normalized,
    ...(Array.isArray(state.recentSessions) ? state.recentSessions : []),
  ]
    .filter((entry, index, array) => array.findIndex((candidate) => candidate.id === entry.id) === index)
    .slice(0, MAX_RECENT_LOOP_SESSIONS);
  return state;
}

export function buildLoopSessionId(now = Date.now()) {
  return `LS-${now}-${randomBytes(3).toString("hex")}`;
}

export function normalizeLoopDescriptor(loop) {
  const record = normalizeRecord(loop, null);
  if (!record) {
    return null;
  }

  const loopId = normalizeString(record.id) || normalizeString(record.loopId);
  const nodes = uniqueStrings(record.nodes);
  if (!loopId || nodes.length < 2) {
    return null;
  }

  return {
    loopId,
    kind: normalizeString(record.kind) || "cycle-loop",
    entryAgentId: normalizeString(record.entryAgentId) || nodes[0],
    nodes,
    phaseOrder: uniqueStrings(record.phaseOrder),
    metadata: normalizeRecord(record.metadata, null),
  };
}

export function resolveLoopSessionRuntimeStatus(session, resolvedLoop) {
  if (!session) {
    return null;
  }

  if (
    session.status === "concluded"
    || session.status === "abandoned"
    || session.status === "failed"
    || session.status === "interrupted"
  ) {
    return session.status;
  }

  if (session.loopId && !resolvedLoop) {
    return "broken";
  }

  if (resolvedLoop && resolvedLoop.active !== true) {
    return "broken";
  }

  return session.status || "active";
}

export function resolveLoopSessionEntry(session, resolvedLoop = null) {
  const normalized = normalizeLoopSessionEntry(session);
  if (!normalized) {
    return null;
  }

  const missingEdges = Array.isArray(resolvedLoop?.missingEdges) ? resolvedLoop.missingEdges : [];
  const runtimeStatus = resolveLoopSessionRuntimeStatus(normalized, resolvedLoop);

  return {
    ...normalized,
    active: normalized.status === "active",
    runtimeStatus,
    loopActive: resolvedLoop?.active === true,
    loopCycleDetected: resolvedLoop?.cycleDetected === true,
    missingEdges,
  };
}
