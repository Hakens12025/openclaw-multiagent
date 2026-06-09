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
import { CONTRACT_STATUS } from "../core/runtime-status.js";
import { CONTRACTS_DIR } from "../state.js";
import { mkdir } from "node:fs/promises";
import {
  getContractPath,
  persistContractSnapshot,
} from "../contracts.js";
import { dispatchRouteExecutionContract } from "../routing/dispatch-graph-policy.js";
import { EVENT_TYPE } from "../core/event-types.js";
import { broadcast } from "../transport/sse.js";
import {
  materializeTaskStagePlan,
  materializeTaskStageRuntime,
  buildInitialTaskStageRuntime,
} from "../task-stage-plan.js";
import { buildAgentContractSessionKey } from "../session-keys.js";
import { cleanupInterruptedLoopContracts } from "./loop-cleanup.js";
import { resolveLoopStartBudget } from "./loop-budget.js";
import {
  buildLoopContractId,
  buildLoopContract,
} from "./loop-contract-builder.js";

const LOOP_RUNTIME_LOCK_KEY = "loop-runtime";

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

async function readActiveLoopRuntime() {
  const state = await loadLoopSessionState();
  return normalizeLoopRuntime(state.activeSession);
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

// W5 alias — kept for back-compat
export async function getActiveLoopRuntime() {
  return loadActiveLoopRuntime();
}

export async function startLoopRound(config, wakeupFunc, replyTo, logger) {
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
    const stagePlan = materializeTaskStagePlan({
      contractId,
      stagePlan: normalizedConfig.taskStagePlan || null,
    });
    const stageRuntime = stagePlan
      ? (
          materializeTaskStageRuntime({
            stagePlan,
            stageRuntime: normalizedConfig.taskStageRuntime || null,
          }) || buildInitialTaskStageRuntime({ stagePlan })
        )
      : null;
    const loopBudget = resolveLoopStartBudget(normalizedConfig, { currentRound: 1, loopSpec: targetLoop });
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
      semanticStageMode: stagePlan ? "task_stage_truth" : null,
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
      workingDir: normalizeString(normalizedConfig.workingDir) || null,
      taskStagePlan: stagePlan,
      taskStageRuntime: stageRuntime,
    });

    await mkdir(CONTRACTS_DIR, { recursive: true });
    await persistContractSnapshot(getContractPath(contractId), contract, logger);

    const dispatchApi = normalizedConfig.runtimeApi && typeof normalizedConfig.runtimeApi === "object"
      ? normalizedConfig.runtimeApi
      : null;
    const dispatchResult = await dispatchRouteExecutionContract(
      contractId,
      "system",
      startAgent,
      dispatchApi,
      logger,
      {
        wakeupFunc,
        wakePayload: {
          sessionKey: buildAgentContractSessionKey(startAgent, contractId),
        },
        runtimeAuthority: {
          kind: "loop_start",
          loopId: targetLoop.id,
          startAgent,
          entryAgentId: targetLoop.entryAgentId || null,
          nodes: targetLoop.nodes,
        },
      },
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
      wake: dispatchResult?.wake || null,
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
  runtimeApi = null,
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
    runtimeApi,
  }, wakeupFunc, null, logger);

  if (resumed?.action !== "started") {
    return resumed;
  }

  return {
    ...resumed,
    action: "resumed",
  };
}
