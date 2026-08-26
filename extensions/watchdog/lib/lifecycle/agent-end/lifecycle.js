import { getTrackingState } from "../../store/tracker-store.js";
import { broadcast } from "../../transport/sse.js";
import { EVENT_TYPE } from "../../core/event-types.js";
import { SYSTEM_ACTION_STATUS } from "../../core/runtime-status.js";
import { getErrorMessage } from "../../core/normalize.js";
import { handleCrashRecovery } from "../crash-recovery.js";
import {
  MAX_RETRY_COUNT, RETRY_DELAYS,
} from "../../state.js";
import {
  AGENT_END_MAIN_STAGES,
  AGENT_END_FINALLY_STAGES,
  createFinalizeSession,
} from "./stage-definitions.js";
// agent_end 在飞注册表（isAgentEndInFlight/waitForAgentEndSettled 消费面）已迁到
// 中立模块 session-phase-store：唤醒原语要消费相位真值，注册表留在本文件会成环。
// 本文件只负责注册/转发/清除在飞条目。
import {
  getActiveAgentEndRun,
  registerAgentEndRun,
} from "../../session/session-phase-store.js";

function shouldRunStage(stage, context) {
  return typeof stage.match === "function" ? stage.match(context) === true : true;
}

async function runStageList(stages, context, { swallowErrors = false } = {}) {
  for (const stage of stages) {
    if (!shouldRunStage(stage, context)) {
      // skip 留痕(2026-08-10 幽灵回合事故:tracker 缺席时收尾各 stage 静默跳过、
      // 零日志)。此处只收集,runAgentEndLifecycle 跑完 finally 段后统一打一行。
      (context._skippedStages ??= []).push(stage.id);
      continue;
    }
    try {
      await stage.run(context);
    } catch (error) {
      if (swallowErrors) {
        stage.onError?.(context, error);
        continue;
      }
      throw error;
    }
  }
}

export function listAgentEndMainStages() {
  return [...AGENT_END_MAIN_STAGES];
}

export function createAgentEndLifecycleContext({
  event,
  ctx,
  api,
  logger,
  trackingState,
}) {
  const sessionKey = ctx.sessionKey;
  const agentId = ctx.agentId ?? "unknown";
  const context = {
    event,
    ctx,
    api,
    logger,
    sessionKey,
    agentId,
    trackingState,
    didFinalizeSession: false,
    didHandleCrashRecovery: false,
    isDirectSession: false,
    contractData: null,
    effectiveContractData: trackingState?.contract || null,
    contractReadDiagnostic: null,
    systemActionResult: { status: SYSTEM_ACTION_STATUS.NO_ACTION, actionType: null },
    executionObservation: { collected: false },
    preserveInbox: false,
    crashRecoveryResult: null,
  };
  context.finalizeSession = createFinalizeSession(context);
  return context;
}

export async function runAgentEndMainStages(context) {
  return runStageList(AGENT_END_MAIN_STAGES, context);
}

export async function runAgentEndFinallyStages(context) {
  return runStageList(AGENT_END_FINALLY_STAGES, context, { swallowErrors: true });
}

async function runAgentEndCrashRecoveryFallback(context, error) {
  if (context.didHandleCrashRecovery || context.event.success) return;
  context.crashRecoveryResult = await handleCrashRecovery({
    agentId: context.agentId,
    sessionKey: context.sessionKey,
    trackingState: context.trackingState,
    error,
    contractReadDiagnostic: context.contractReadDiagnostic,
    api: context.api,
    logger: context.logger,
    maxRetryCount: MAX_RETRY_COUNT,
    retryDelays: RETRY_DELAYS,
  });
  context.didHandleCrashRecovery = true;
}

export async function runAgentEndLifecycle({
  event,
  ctx,
  api,
  logger,
  trackingState,
}) {
  const sessionKey = ctx?.sessionKey;
  const agentId = ctx?.agentId ?? "unknown";
  const resolvedTrackingState = trackingState || (sessionKey ? getTrackingState(sessionKey) : null);
  const existingRun = getActiveAgentEndRun(sessionKey);
  if (existingRun) {
    return existingRun;
  }

  // Register a deferred placeholder BEFORE the async work starts so that any
  // concurrent synchronous call on the same microtask tick already sees an entry.
  const agentEndRegistration = registerAgentEndRun(sessionKey);

  const runPromise = (async () => {
    const lifecycleContext = createAgentEndLifecycleContext({
      event,
      ctx,
      api,
      logger,
      trackingState: resolvedTrackingState,
    });

    try {
      await runAgentEndMainStages(lifecycleContext);
    } catch (error) {
      const message = getErrorMessage(error);
      logger.error(`[watchdog] agent_end handler failed for ${sessionKey}: ${message}`);
      broadcast("alert", {
        type: EVENT_TYPE.RUNTIME_AGENT_END_FAILED,
        agentId,
        sessionKey,
        contractId: resolvedTrackingState?.contract?.id || lifecycleContext.contractData?.id || null,
        error: message,
        success: event?.success === true,
        ts: Date.now(),
      });

      if (!lifecycleContext.didHandleCrashRecovery && event?.success !== true) {
        try {
          await runAgentEndCrashRecoveryFallback(lifecycleContext, event?.error || message);
        } catch (recoveryError) {
          const recoveryMessage = getErrorMessage(recoveryError);
          logger.error(`[watchdog] crash recovery failed for ${sessionKey}: ${recoveryMessage}`);
          broadcast("alert", {
            type: EVENT_TYPE.RUNTIME_CRASH_RECOVERY_FAILED,
            agentId,
            sessionKey,
            contractId: resolvedTrackingState?.contract?.id || lifecycleContext.contractData?.id || null,
            error: recoveryMessage,
            ts: Date.now(),
          });
        }
      }
    } finally {
      await runAgentEndFinallyStages(lifecycleContext);
      const skippedStageIds = lifecycleContext._skippedStages;
      if (skippedStageIds?.length > 0) {
        logger.info(`[agent-end] stage skips for ${sessionKey}: ${skippedStageIds.join(", ")}`);
      }
    }

    return lifecycleContext;
  })();

  // Forward the actual promise result to the deferred entry already registered in the
  // phase store, so that any concurrent caller who received the entry gets the final value.
  agentEndRegistration.settle(runPromise);

  try {
    return await runPromise;
  } finally {
    agentEndRegistration.clear();
  }
}

// Re-export submodule exports so existing consumers don't break
export {
  refreshEffectiveContractDataAfterTransport,
  mergeRuntimeDiagnostics,
} from "./contract-refresh.js";
export {
  handleSuccessfulTrackingCompletion,
} from "./terminal.js";
