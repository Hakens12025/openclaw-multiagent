import { randomBytes } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { normalizeRecord, normalizeString, uniqueStrings } from "../core/normalize.js";
import { OC, atomicWriteFile, withLock } from "../state.js";

const RESEARCH_LAB = join(OC, "research-lab");
export const LOOP_SESSION_STATE_FILE = join(RESEARCH_LAB, "loop_session_state.json");
const LOOP_SESSION_LOCK_KEY = "loop-session-state";
const MAX_RECENT_LOOP_SESSIONS = 20;

function normalizeTransition(value) {
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

function normalizeLoopSessionEntry(value) {
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
      maxRounds: Number.isFinite(budget.maxRounds) ? budget.maxRounds : 10,
      maxExperiments: Number.isFinite(budget.maxExperiments) ? budget.maxExperiments : 30,
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

function buildDefaultLoopSessionState() {
  return {
    activeSession: null,
    recentSessions: [],
  };
}

function normalizeLoopSessionState(value) {
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

async function readLoopSessionStateFromDisk() {
  try {
    const raw = await readFile(LOOP_SESSION_STATE_FILE, "utf8");
    return normalizeLoopSessionState(JSON.parse(raw));
  } catch {
    return buildDefaultLoopSessionState();
  }
}

async function persistLoopSessionState(state) {
  const normalized = normalizeLoopSessionState(state);
  await mkdir(RESEARCH_LAB, { recursive: true });
  await atomicWriteFile(LOOP_SESSION_STATE_FILE, JSON.stringify({
    savedAt: Date.now(),
    ...normalized,
  }, null, 2));
  return normalized;
}

function archiveLoopSession(state, session) {
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

function buildLoopSessionId(now = Date.now()) {
  return `LS-${now}-${randomBytes(3).toString("hex")}`;
}

function normalizeLoopDescriptor(loop) {
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

function resolveLoopSessionRuntimeStatus(session, resolvedLoop) {
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

function resolveLoopSessionEntry(session, resolvedLoop = null) {
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

export async function loadLoopSessionState() {
  return readLoopSessionStateFromDisk();
}

export async function clearLoopSessionState() {
  return withLock(LOOP_SESSION_LOCK_KEY, async () => (
    persistLoopSessionState(buildDefaultLoopSessionState())
  ));
}

export async function pruneLoopSessionsForTopology({
  agentIds = [],
  loopIds = [],
} = {}) {
  const validAgentIds = new Set(
    (Array.isArray(agentIds) ? agentIds : [])
      .map((agentId) => normalizeString(agentId))
      .filter(Boolean),
  );
  const validLoopIds = new Set(
    (Array.isArray(loopIds) ? loopIds : [])
      .map((loopId) => normalizeString(loopId))
      .filter(Boolean),
  );

  function sessionFitsTopology(session) {
    const normalized = normalizeLoopSessionEntry(session);
    if (!normalized) return false;
    const nodes = uniqueStrings(normalized.nodes);
    if (nodes.length > 0 && nodes.some((agentId) => !validAgentIds.has(agentId))) {
      return false;
    }
    const entryAgentId = normalizeString(normalized.entryAgentId);
    if (entryAgentId && !validAgentIds.has(entryAgentId)) {
      return false;
    }
    const loopId = normalizeString(normalized.loopId);
    if (loopId && !validLoopIds.has(loopId)) {
      return false;
    }
    return true;
  }

  return withLock(LOOP_SESSION_LOCK_KEY, async () => {
    const state = await readLoopSessionStateFromDisk();
    const removedSessions = [];

    const activeSession = sessionFitsTopology(state.activeSession)
      ? state.activeSession
      : (state.activeSession ? (removedSessions.push(normalizeLoopSessionEntry(state.activeSession)), null) : null);

    const recentSessions = [];
    for (const session of Array.isArray(state.recentSessions) ? state.recentSessions : []) {
      if (sessionFitsTopology(session)) {
        recentSessions.push(session);
      } else {
        removedSessions.push(normalizeLoopSessionEntry(session));
      }
    }

    if (removedSessions.length === 0) {
      return {
        changed: false,
        state,
        removedSessions: [],
      };
    }

    const nextState = await persistLoopSessionState({
      activeSession,
      recentSessions,
    });
    return {
      changed: true,
      state: nextState,
      removedSessions: removedSessions.filter(Boolean),
    };
  });
}

export async function clearActiveLoopSession({
  reason = "loop_not_active",
  status = "abandoned",
  now = Date.now(),
} = {}) {
  return withLock(LOOP_SESSION_LOCK_KEY, async () => {
    const state = await readLoopSessionStateFromDisk();
    if (!state.activeSession) {
      return null;
    }

    const archivedSession = normalizeLoopSessionEntry({
      ...state.activeSession,
      status: normalizeString(status) || "abandoned",
      concludeReason: normalizeString(reason) || null,
      concludedAt: now,
      updatedAt: now,
    });
    archiveLoopSession(state, archivedSession);
    await persistLoopSessionState(state);
    return archivedSession;
  });
}

export async function startLoopSession({
  loop,
  pipelineId,
  startAgentId = null,
  currentStage,
  round = 1,
  metadata = null,
  now = Date.now(),
  // P0 operational fields
  budget = null,
  requestedTask = null,
  requestedSource = null,
  taskStagePlan = null,
  taskStageRuntime = null,
  semanticStageMode = null,
  resumeFromLoopSessionId = null,
  resumeReason = null,
} = {}) {
  const descriptor = normalizeLoopDescriptor(loop);
  const stage = normalizeString(currentStage);
  const normalizedStartAgentId = normalizeString(startAgentId) || stage;
  if (!descriptor || !stage) {
    return null;
  }

  return withLock(LOOP_SESSION_LOCK_KEY, async () => {
    const state = await readLoopSessionStateFromDisk();
    if (state.activeSession) {
      archiveLoopSession(state, {
        ...state.activeSession,
        status: "abandoned",
        concludeReason: "superseded_on_loop_start",
        concludedAt: now,
        updatedAt: now,
      });
    }

    const session = normalizeLoopSessionEntry({
      id: buildLoopSessionId(now),
      loopId: descriptor.loopId,
      pipelineId: normalizeString(pipelineId) || descriptor.loopId,
      kind: descriptor.kind,
      entryAgentId: descriptor.entryAgentId,
      startAgentId: normalizedStartAgentId,
      currentStage: stage,
      previousStage: null,
      round,
      status: "active",
      nodes: descriptor.nodes,
      phaseOrder: descriptor.phaseOrder,
      transitionCount: 0,
      startedAt: now,
      updatedAt: now,
      metadata: {
        ...(descriptor.metadata || {}),
        ...(normalizeRecord(metadata, null) || {}),
      },
      // P0 operational fields
      budget,
      requestedTask,
      requestedSource,
      taskStagePlan,
      taskStageRuntime,
      semanticStageMode,
      resumeFromLoopSessionId,
      resumeReason,
    });

    state.activeSession = session;
    state.recentSessions = state.recentSessions.filter((entry) => entry.id !== session.id);
    await persistLoopSessionState(state);
    return session;
  });
}

export async function advanceLoopSession({
  sessionId,
  currentStage,
  previousStage = null,
  round = null,
  feedback = null,
  now = Date.now(),
  // P0 operational fields
  budget = undefined,
  feedbackOutput = undefined,
  deadEnds = undefined,
  stageHistory = undefined,
  pendingSoftGate = undefined,
  taskStagePlan = undefined,
  taskStageRuntime = undefined,
  semanticStageMode = undefined,
} = {}) {
  const normalizedSessionId = normalizeString(sessionId);
  const normalizedCurrentStage = normalizeString(currentStage);
  if (!normalizedSessionId || !normalizedCurrentStage) {
    return null;
  }

  return withLock(LOOP_SESSION_LOCK_KEY, async () => {
    const state = await readLoopSessionStateFromDisk();
    const activeSession = normalizeLoopSessionEntry(state.activeSession);
    if (!activeSession || activeSession.id !== normalizedSessionId) {
      return null;
    }

    const normalizedPreviousStage = normalizeString(previousStage);
    const transition = normalizedPreviousStage && normalizedPreviousStage !== normalizedCurrentStage
      ? {
          from: normalizedPreviousStage,
          to: normalizedCurrentStage,
          ts: now,
          feedback: normalizeString(feedback) || null,
        }
      : null;

    const patch = {
      ...activeSession,
      previousStage: normalizedPreviousStage || activeSession.previousStage || null,
      currentStage: normalizedCurrentStage,
      round: Number.isFinite(round) ? round : activeSession.round,
      transitionCount: activeSession.transitionCount + (transition ? 1 : 0),
      lastTransition: transition || activeSession.lastTransition,
      updatedAt: now,
    };
    // Merge operational fields only if explicitly provided (undefined = no change)
    if (budget !== undefined) patch.budget = budget;
    if (feedbackOutput !== undefined) patch.feedbackOutput = feedbackOutput;
    if (deadEnds !== undefined) patch.deadEnds = deadEnds;
    if (stageHistory !== undefined) patch.stageHistory = stageHistory;
    if (pendingSoftGate !== undefined) patch.pendingSoftGate = pendingSoftGate;
    if (taskStagePlan !== undefined) patch.taskStagePlan = taskStagePlan;
    if (taskStageRuntime !== undefined) patch.taskStageRuntime = taskStageRuntime;
    if (semanticStageMode !== undefined) patch.semanticStageMode = semanticStageMode;

    state.activeSession = normalizeLoopSessionEntry(patch);

    await persistLoopSessionState(state);
    return state.activeSession;
  });
}

export async function concludeLoopSession({
  sessionId,
  reason = null,
  currentStage = "concluded",
  round = null,
  status = "concluded",
  now = Date.now(),
  // P0 operational fields
  interruptedStage = null,
  stageHistory = undefined,
  deadEnds = undefined,
  conclusionArtifact = undefined,
  taskStagePlan = undefined,
  taskStageRuntime = undefined,
  semanticStageMode = undefined,
} = {}) {
  const normalizedSessionId = normalizeString(sessionId);
  if (!normalizedSessionId) {
    return null;
  }

  return withLock(LOOP_SESSION_LOCK_KEY, async () => {
    const state = await readLoopSessionStateFromDisk();
    const activeSession = normalizeLoopSessionEntry(state.activeSession);
    if (!activeSession || activeSession.id !== normalizedSessionId) {
      return null;
    }

    const patch = {
      ...activeSession,
      currentStage: normalizeString(currentStage) || activeSession.currentStage || "concluded",
      round: Number.isFinite(round) ? round : activeSession.round,
      status: normalizeString(status) || "concluded",
      concludedAt: now,
      concludeReason: normalizeString(reason) || null,
      updatedAt: now,
    };
    if (interruptedStage) patch.interruptedStage = interruptedStage;
    if (stageHistory !== undefined) patch.stageHistory = stageHistory;
    if (deadEnds !== undefined) patch.deadEnds = deadEnds;
    if (conclusionArtifact !== undefined) patch.conclusionArtifact = conclusionArtifact;
    if (taskStagePlan !== undefined) patch.taskStagePlan = taskStagePlan;
    if (taskStageRuntime !== undefined) patch.taskStageRuntime = taskStageRuntime;
    if (semanticStageMode !== undefined) patch.semanticStageMode = semanticStageMode;

    const concludedSession = normalizeLoopSessionEntry(patch);

    archiveLoopSession(state, concludedSession);
    await persistLoopSessionState(state);
    return concludedSession;
  });
}

export async function listResolvedLoopSessions({
  loops = null,
} = {}) {
  const resolvedLoops = Array.isArray(loops) ? loops : [];
  const state = await loadLoopSessionState();
  return [
    state.activeSession,
    ...(Array.isArray(state.recentSessions) ? state.recentSessions : []),
  ]
    .map((session) => {
      const loopId = normalizeString(session?.loopId);
      const resolvedLoop = loopId
        ? resolvedLoops.find((loop) => normalizeString(loop?.id) === loopId) || null
        : null;
      return resolveLoopSessionEntry(session, resolvedLoop);
    })
    .filter(Boolean);
}

/**
 * Get active loop session state. Returns the normalized active session
 * or null if no active loop. This is loop-session truth, not pipeline runtime truth.
 */
export async function getActiveLoopState() {
  const state = await readLoopSessionStateFromDisk();
  return state.activeSession || null;
}

export async function getActiveResolvedLoopSession({
  loops = null,
} = {}) {
  const resolvedLoops = Array.isArray(loops) ? loops : [];
  const state = await loadLoopSessionState();
  const loopId = normalizeString(state.activeSession?.loopId);
  const resolvedLoop = loopId
    ? resolvedLoops.find((loop) => normalizeString(loop?.id) === loopId) || null
    : null;
  return resolveLoopSessionEntry(state.activeSession, resolvedLoop);
}
