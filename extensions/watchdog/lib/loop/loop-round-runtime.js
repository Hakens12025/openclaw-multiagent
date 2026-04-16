import { randomBytes } from "node:crypto";
import { join } from "node:path";

import {
  findActiveGraphLoopsByMemberAgent,
  listResolvedGraphLoops,
} from "./graph-loop-registry.js";
import {
  clearActiveLoopSession,
  concludeLoopSession,
  listResolvedLoopSessions,
  loadLoopSessionState,
  startLoopSession,
} from "./loop-session-store.js";
import { normalizeString } from "../core/normalize.js";
import { withLock } from "../state.js";
import { annotateExecutionContract } from "../protocol-primitives.js";
import { CONTRACT_STATUS } from "../core/runtime-status.js";
import { agentWorkspace, CONTRACTS_DIR } from "../state.js";
import { mkdir } from "node:fs/promises";
import {
  getContractPath,
  mutateContractSnapshot,
  persistContractSnapshot,
} from "../contracts.js";
import { dispatchRouteExecutionContract } from "../routing/dispatch-graph-policy.js";
import { removeDispatchContract } from "../routing/dispatch-runtime-state.js";
import { EVENT_TYPE } from "../core/event-types.js";
import { broadcast } from "../transport/sse.js";
import { normalizeTerminalOutcome } from "../terminal-outcome.js";
import {
  buildInitialTaskStageRuntime,
  deriveCompatibilityPhases,
  deriveCompatibilityTotal,
  materializeTaskStagePlan,
  materializeTaskStageRuntime,
} from "../task-stage-plan.js";
import { buildTaskStagePlanFromTask } from "../task-stage-planner.js";
import { buildAgentContractSessionKey } from "../session-keys.js";
import { listSharedContractEntries } from "../store/contract-store.js";
import { routeInbox } from "../../runtime-mailbox.js";

const LOOP_RUNTIME_LOCK_KEY = "loop-runtime";
const DEFAULT_LOOP_MAX_ROUNDS = 3;
const DEFAULT_LOOP_MAX_EXPERIMENTS = 30;

function normalizePositiveInteger(value, fallback = null) {
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) {
    return Math.trunc(numeric);
  }
  return fallback;
}

function normalizeLoopBudget(budget, { currentRound = 1 } = {}) {
  const source = budget && typeof budget === "object" ? budget : {};
  const normalizedCurrentRound = normalizePositiveInteger(currentRound, 1) || 1;
  return {
    maxRounds: normalizePositiveInteger(source.maxRounds, DEFAULT_LOOP_MAX_ROUNDS),
    maxExperiments: normalizePositiveInteger(source.maxExperiments, DEFAULT_LOOP_MAX_EXPERIMENTS),
    usedRounds: normalizePositiveInteger(source.usedRounds, normalizedCurrentRound) || normalizedCurrentRound,
    usedExperiments: normalizePositiveInteger(source.usedExperiments, 0) || 0,
  };
}

function resolveLoopStartBudget(config, { currentRound = 1 } = {}) {
  const source = config && typeof config === "object" ? config : {};
  const budget = source.budget && typeof source.budget === "object" ? source.budget : {};
  return normalizeLoopBudget({
    ...budget,
    ...(source.maxRounds !== undefined ? { maxRounds: source.maxRounds } : {}),
    ...(source.maxExperiments !== undefined ? { maxExperiments: source.maxExperiments } : {}),
  }, {
    currentRound,
  });
}

function normalizeLoopRuntime(session) {
  if (!session) {
    return null;
  }
  return {
    pipelineId: session.pipelineId || session.loopId || null,
    loopId: session.loopId || null,
    loopSessionId: session.id || null,
    entryAgentId: session.entryAgentId || null,
    startAgentId: session.startAgentId || null,
    currentStage: session.currentStage || null,
    round: session.round || 1,
    budget: session.budget || null,
    feedbackOutput: session.feedbackOutput || null,
    deadEnds: session.deadEnds || [],
    stageHistory: session.stageHistory || [],
    requestedTask: session.requestedTask || null,
    requestedSource: session.requestedSource || null,
    taskStagePlan: session.taskStagePlan || null,
    taskStageRuntime: session.taskStageRuntime || null,
    semanticStageMode: session.semanticStageMode || null,
    pendingSoftGate: session.pendingSoftGate || null,
  };
}

function buildLoopContractId(now = Date.now()) {
  return `TC-${now}-${randomBytes(3).toString("hex")}`;
}

async function readActiveLoopRuntime() {
  const state = await loadLoopSessionState();
  return normalizeLoopRuntime(state.activeSession);
}

function resolveLoopTarget({
  requestedLoopId = null,
  requestedStartAgent = null,
  loops,
}) {
  const resolvedLoops = Array.isArray(loops) ? loops : [];
  if (requestedLoopId) {
    return resolvedLoops.find((loop) => loop?.id === requestedLoopId) || null;
  }
  if (requestedStartAgent) {
    const matchingLoops = findActiveGraphLoopsByMemberAgent(resolvedLoops, requestedStartAgent);
    return matchingLoops.length === 1 ? matchingLoops[0] : null;
  }
  const activeLoops = resolvedLoops.filter((loop) => loop?.active === true);
  if (activeLoops.length === 1) {
    return activeLoops[0];
  }
  if (resolvedLoops.length === 1) {
    return resolvedLoops[0];
  }
  return null;
}

function findLatestLoopSessionByLoopId(loopSessions, loopId) {
  const normalizedLoopId = normalizeString(loopId);
  if (!normalizedLoopId) {
    return null;
  }
  return (Array.isArray(loopSessions) ? loopSessions : [])
    .filter((session) => session?.loopId === normalizedLoopId)
    .sort((left, right) => (right?.updatedAt || 0) - (left?.updatedAt || 0))[0] || null;
}

async function wakeLoopTarget(wakeupFunc, targetAgentId, contractId, logger) {
  if (typeof wakeupFunc !== "function") {
    return null;
  }
  try {
    return await wakeupFunc(targetAgentId, {
      sessionKey: buildAgentContractSessionKey(targetAgentId, contractId),
    });
  } catch (error) {
    logger?.warn?.(`[loop-runtime] wake failed for ${targetAgentId}: ${error.message}`);
    return {
      ok: false,
      targetAgent: targetAgentId,
      error: error.message,
    };
  }
}

function buildLoopStageDescriptor({
  loopId,
  loopSessionId,
  startAgent,
  round,
  stageRuntime,
}) {
  return {
    pipelineId: loopId,
    loopId,
    loopSessionId,
    stage: startAgent,
    round,
    semanticStageId: stageRuntime?.currentStageId || null,
  };
}

function buildLoopContract({
  contractId,
  loop,
  loopSessionId,
  startAgent,
  requestedTask,
  requestedSource,
  operatorContext,
  replyTo,
  taskStagePlan = null,
  taskStageRuntime = null,
}) {
  const stagePlan = buildTaskStagePlanFromTask({
    contractId,
    task: requestedTask,
    stagePlan: taskStagePlan,
  });
  const stageRuntime = materializeTaskStageRuntime({
    stagePlan,
    stageRuntime: taskStageRuntime,
  }) || buildInitialTaskStageRuntime({ stagePlan });
  return annotateExecutionContract({
    id: contractId,
    task: requestedTask,
    assignee: startAgent,
    ...(replyTo ? { replyTo } : {}),
    stagePlan,
    stageRuntime,
    phases: deriveCompatibilityPhases(stagePlan),
    total: deriveCompatibilityTotal(stagePlan),
    output: join(agentWorkspace(startAgent), "output", `${contractId}.md`),
    status: CONTRACT_STATUS.PENDING,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    requestedSource: requestedSource || null,
    operatorContext: operatorContext || null,
    pipelineStage: buildLoopStageDescriptor({
      loopId: loop.id,
      loopSessionId,
      startAgent,
      round: 1,
      stageRuntime,
    }),
  }, {
    source: "loop-runtime",
    route: "loop",
  });
}

function matchesLoopSessionContract(contract, loopSessionId) {
  return contract?.pipelineStage?.loopSessionId === loopSessionId;
}

function buildInterruptedContractOutcome({
  reason,
  loopId,
  loopSessionId,
  interruptedStage,
}) {
  return normalizeTerminalOutcome({
    status: CONTRACT_STATUS.CANCELLED,
    source: "loop_runtime_interrupt",
    reason: ["loop_interrupted", reason, interruptedStage].filter(Boolean).join(":"),
    summary: `Loop ${loopId || "unknown"} interrupted while ${interruptedStage || "unknown"} was active`,
    artifact: {
      loopId: loopId || null,
      loopSessionId: loopSessionId || null,
      interruptedStage: interruptedStage || null,
    },
  }, {
    terminalStatus: CONTRACT_STATUS.CANCELLED,
  });
}

async function cleanupInterruptedLoopContracts(activeSession, reason, logger) {
  if (!activeSession?.id) {
    return {
      matchedContracts: [],
      updatedContracts: [],
    };
  }

  const entries = await listSharedContractEntries();
  const matchedContracts = entries
    .filter((entry) => matchesLoopSessionContract(entry?.contract, activeSession.id))
    .map((entry) => ({
      contractId: entry.contract.id,
      assignee: entry.contract.assignee || null,
      path: entry.path,
    }));

  const interruptedStage = activeSession.currentStage || null;
  const terminalOutcome = buildInterruptedContractOutcome({
    reason,
    loopId: activeSession.loopId || activeSession.pipelineId || null,
    loopSessionId: activeSession.id,
    interruptedStage,
  });

  for (const entry of matchedContracts) {
    await mutateContractSnapshot(entry.path, logger, (contract) => {
      contract.status = CONTRACT_STATUS.CANCELLED;
      contract.terminalOutcome = terminalOutcome;
      contract.runtimeDiagnostics = {
        ...(contract.runtimeDiagnostics && typeof contract.runtimeDiagnostics === "object"
          ? contract.runtimeDiagnostics
          : {}),
        loopInterrupt: {
          reason: normalizeString(reason) || "manual_interrupt",
          loopId: activeSession.loopId || activeSession.pipelineId || null,
          loopSessionId: activeSession.id,
          interruptedStage,
          ts: Date.now(),
        },
      };
    });
    await removeDispatchContract(entry.contractId, logger);
    if (entry.assignee) {
      await routeInbox(entry.assignee, logger, {
        contractIdHint: entry.contractId,
        contractPathHint: entry.path,
      });
    }
  }

  return {
    matchedContracts,
    updatedContracts: matchedContracts.map((entry) => entry.contractId),
  };
}

export async function loadActiveLoopRuntime() {
  return readActiveLoopRuntime();
}

export async function withLoopRuntimeLock(fn, { skipLock = false } = {}) {
  if (typeof fn !== "function") {
    return fn?.();
  }
  return skipLock ? fn() : withLock(LOOP_RUNTIME_LOCK_KEY, fn);
}

export async function getActiveLoopRuntime() {
  return loadActiveLoopRuntime();
}

export async function startLoopRound(config, wakeupFunc, enqueueFunc, replyTo, logger) {
  void enqueueFunc;
  return withLoopRuntimeLock(async () => {
    const existing = await readActiveLoopRuntime();
    if (existing?.currentStage) {
      return {
        action: "busy",
        error: `loop ${existing.loopId || existing.pipelineId} already active`,
        pipelineId: existing.pipelineId || null,
        currentStage: existing.currentStage,
      };
    }

    const normalizedConfig = config && typeof config === "object" ? config : {};
    const startAgent = normalizeString(normalizedConfig.startAgent);
    const requestedTask = normalizeString(normalizedConfig.requestedTask);
    if (!startAgent || !requestedTask) {
      return {
        action: "invalid_params",
        error: "startLoopRound requires startAgent and requestedTask",
      };
    }

    const loops = await listResolvedGraphLoops();
    const targetLoop = resolveLoopTarget({
      requestedLoopId: normalizeString(normalizedConfig.loopId) || normalizeString(normalizedConfig.pipelineId),
      requestedStartAgent: startAgent,
      loops,
    });
    if (!targetLoop) {
      return {
        action: "missing_loop",
        error: "could not resolve active graph loop",
      };
    }
    if (targetLoop.active !== true) {
      return {
        action: "loop_broken",
        error: "loop is not structurally active",
        loopId: targetLoop.id,
        missingEdges: Array.isArray(targetLoop.missingEdges) ? targetLoop.missingEdges : [],
      };
    }
    if (!Array.isArray(targetLoop.nodes) || !targetLoop.nodes.includes(startAgent)) {
      return {
        action: "invalid_stage",
        error: `stage ${startAgent} is not part of loop ${targetLoop.id}`,
        loopId: targetLoop.id,
      };
    }

    const contractId = buildLoopContractId();
    const stagePlan = buildTaskStagePlanFromTask({
      contractId,
      task: requestedTask,
      stagePlan: materializeTaskStagePlan({
        contractId,
        stagePlan: normalizedConfig.taskStagePlan || null,
      }),
    });
    const stageRuntime = materializeTaskStageRuntime({
      stagePlan,
      stageRuntime: normalizedConfig.taskStageRuntime || null,
    }) || buildInitialTaskStageRuntime({ stagePlan });
    const loopBudget = resolveLoopStartBudget(normalizedConfig, { currentRound: 1 });
    const loopSession = await startLoopSession({
      loop: targetLoop,
      pipelineId: targetLoop.id,
      startAgentId: startAgent,
      currentStage: startAgent,
      round: 1,
      budget: loopBudget,
      requestedTask,
      requestedSource: normalizeString(normalizedConfig.requestedSource) || "loop.start",
      taskStagePlan: stagePlan,
      taskStageRuntime: stageRuntime,
      semanticStageMode: "task_stage_truth",
      resumeFromLoopSessionId: normalizeString(normalizedConfig.resumeFromLoopSessionId) || null,
      resumeReason: normalizeString(normalizedConfig.resumeReason) || null,
      metadata: {
        operatorContext: normalizedConfig.operatorContext || null,
      },
    });

    const contract = buildLoopContract({
      contractId,
      loop: targetLoop,
      loopSessionId: loopSession?.id || null,
      startAgent,
      requestedTask,
      requestedSource: normalizeString(normalizedConfig.requestedSource) || "loop.start",
      operatorContext: normalizedConfig.operatorContext || null,
      replyTo: normalizedConfig.replyTo ?? replyTo ?? null,
      taskStagePlan: stagePlan,
      taskStageRuntime: stageRuntime,
    });

    await mkdir(CONTRACTS_DIR, { recursive: true });
    await persistContractSnapshot(getContractPath(contractId), contract, logger);

    const dispatchResult = await dispatchRouteExecutionContract(
      contractId,
      "system",
      startAgent,
      null,
      logger,
    );
    if (dispatchResult?.failed) {
      await clearActiveLoopSession({
        reason: "loop_start_dispatch_failed",
        status: "failed",
      });
      return {
        action: "dispatch_failed",
        error: `failed to dispatch loop contract to ${startAgent}`,
        pipelineId: targetLoop.id,
        loopId: targetLoop.id,
        loopSessionId: loopSession?.id || null,
        contractId,
        targetAgent: startAgent,
      };
    }
    const wake = dispatchResult?.queued
      ? null
      : await wakeLoopTarget(wakeupFunc, startAgent, contractId, logger);

    broadcast("alert", {
      type: EVENT_TYPE.LOOP_STARTED,
      pipelineId: targetLoop.id,
      loopId: targetLoop.id,
      loopSessionId: loopSession?.id || null,
      contractId,
      initialStage: startAgent,
      targetAgent: startAgent,
      ts: Date.now(),
    });

    return {
      action: "started",
      pipelineId: targetLoop.id,
      loopId: targetLoop.id,
      loopSessionId: loopSession?.id || null,
      contractId,
      currentStage: startAgent,
      targetAgent: startAgent,
      wake,
    };
  });
}

export async function concludeLoopRound(reason, logger, options = {}) {
  const { skipLock = false } = options || {};
  return withLoopRuntimeLock(async () => {
    const state = await loadLoopSessionState();
    const activeSession = state.activeSession || null;
    if (!activeSession?.id) {
      return { action: "no_pipeline" };
    }
    const cleanup = await cleanupInterruptedLoopContracts(
      activeSession,
      normalizeString(reason) || "manual_conclude",
      logger,
    );
    const concluded = await concludeLoopSession({
      sessionId: activeSession.id,
      reason: normalizeString(reason) || "manual_conclude",
      currentStage: activeSession.currentStage || "concluded",
      round: activeSession.round || 1,
      status: "concluded",
      taskStagePlan: activeSession.taskStagePlan || null,
      taskStageRuntime: activeSession.taskStageRuntime || null,
      semanticStageMode: activeSession.semanticStageMode || null,
    });
    logger?.info?.(`[loop-runtime] concluded ${activeSession.loopId || activeSession.pipelineId}`);
    return {
      action: concluded ? "concluded" : "no_pipeline",
      pipelineId: activeSession.pipelineId || activeSession.loopId || null,
      loopId: activeSession.loopId || null,
      loopSessionId: activeSession.id,
      reason: normalizeString(reason) || "manual_conclude",
      round: activeSession.round || 1,
      interruptedContracts: cleanup.updatedContracts,
    };
  }, { skipLock });
}

export async function interruptLoopRound({
  reason = "manual_interrupt",
  loopId = null,
} = {}, logger = null) {
  return withLoopRuntimeLock(async () => {
    const state = await loadLoopSessionState();
    const activeSession = state.activeSession || null;
    if (!activeSession?.id) {
      return { action: "no_pipeline" };
    }
    if (loopId && activeSession.loopId !== loopId) {
      return {
        action: "loop_mismatch",
        error: `active loop is ${activeSession.loopId}, not ${loopId}`,
        pipelineId: activeSession.pipelineId || null,
        loopId: activeSession.loopId || null,
      };
    }

    const cleanup = await cleanupInterruptedLoopContracts(
      activeSession,
      normalizeString(reason) || "manual_interrupt",
      logger,
    );

    const interrupted = await concludeLoopSession({
      sessionId: activeSession.id,
      reason,
      currentStage: activeSession.currentStage || null,
      round: activeSession.round || 1,
      status: "interrupted",
      interruptedStage: activeSession.currentStage || null,
      taskStagePlan: activeSession.taskStagePlan || null,
      taskStageRuntime: activeSession.taskStageRuntime || null,
      semanticStageMode: activeSession.semanticStageMode || null,
    });
    logger?.info?.(`[loop-runtime] interrupted ${activeSession.loopId || activeSession.pipelineId}`);
    return {
      action: interrupted ? "interrupted" : "no_pipeline",
      pipelineId: activeSession.pipelineId || null,
      loopId: activeSession.loopId || null,
      loopSessionId: activeSession.id,
      interruptedStage: activeSession.currentStage || null,
      reason,
      round: activeSession.round || 1,
      interruptedContracts: cleanup.updatedContracts,
    };
  });
}

export async function resumeLoopRound({
  loopId = null,
  startStage = null,
  reason = "manual_resume",
} = {}, wakeupFunc = null, logger = null) {
  const existing = await readActiveLoopRuntime();
  if (existing?.currentStage) {
    return {
      action: "busy",
      error: `loop ${existing.loopId || existing.pipelineId} already active`,
      pipelineId: existing.pipelineId || null,
      currentStage: existing.currentStage,
    };
  }

  const loops = await listResolvedGraphLoops();
  const loopSessions = await listResolvedLoopSessions({ loops });
  const normalizedLoopId = normalizeString(loopId);
  const targetLoop = resolveLoopTarget({
    requestedLoopId: normalizedLoopId,
    requestedStartAgent: null,
    loops,
  });
  if (!targetLoop) {
    return {
      action: "missing_loop",
      error: "could not resolve a loop to resume",
    };
  }

  const latestSession = findLatestLoopSessionByLoopId(loopSessions, targetLoop.id);
  const requestedTask = normalizeString(latestSession?.requestedTask) || `恢复 loop ${targetLoop.id}`;
  const requestedStage = normalizeString(startStage)
    || normalizeString(latestSession?.currentStage)
    || normalizeString(targetLoop.entryAgentId);

  const resumed = await startLoopRound({
    pipelineId: targetLoop.id,
    loopId: targetLoop.id,
    startAgent: requestedStage,
    requestedTask,
    requestedSource: `loop.resume:${reason}`,
    budget: latestSession?.budget || null,
    taskStagePlan: latestSession?.taskStagePlan || null,
    taskStageRuntime: latestSession?.taskStageRuntime || null,
    resumeFromLoopSessionId: latestSession?.id || null,
    resumeReason: reason,
  }, wakeupFunc, null, null, logger);

  if (resumed?.action !== "started") {
    return resumed;
  }

  return {
    ...resumed,
    action: "resumed",
  };
}
