import { readFile, unlink } from "node:fs/promises";
import { join } from "node:path";

import {
  MAX_RETRY_COUNT, RETRY_DELAYS, agentWorkspace,
} from "../state.js";
import { broadcast } from "../transport/sse.js";
import { EVENT_TYPE } from "../core/event-types.js";
import {
  cleanupAgentEndTransport,
  handleAgentEndTransport,
} from "./agent-end-transport.js";
import { systemActionConsume } from "../system-action/system-action-consumer.js";
import { extractActionMarkers } from "../action-marker-parser.js";
import { buildStagePlanFromMarkers } from "../stage-marker-parser.js";
import { extractFindingMarkers, deriveVerdictFromFindings } from "../finding-marker-parser.js";
import { buildReviewerResult } from "../harness/reviewer-result.js";
import { materializeTaskStagePlan } from "../task-stage-plan.js";
import { isDirectRequestEnvelope } from "../protocol-primitives.js";
import {
  finalizeAgentSession,
  SESSION_FINALIZE_MODE,
} from "./runtime-lifecycle.js";
import { handleCrashRecovery } from "./crash-recovery.js";
import { clearTrace } from "../store/execution-trace-store.js";
import { SYSTEM_ACTION_STATUS } from "../core/runtime-status.js";
import { consumeLateCompletionLease } from "../late-completion-lease.js";
import { getTrackingState } from "../store/tracker-store.js";

import { getErrorMessage } from "../core/normalize.js";
import { normalizeSystemIntent } from "../protocol-primitives.js";
import { mutateContractSnapshot, getContractPath, readContractSnapshotById } from "../contracts.js";
import {
  readTrackingContractSnapshot,
  refreshEffectiveContractDataAfterTransport,
  mergeRuntimeDiagnostics,
} from "./agent-end-contract-refresh.js";
import { routeInbox } from "../../runtime-mailbox.js";
import {
  normalizePipelineStageDescriptor,
  resolveStageAdvanceSignal,
} from "./agent-end-stage-advance.js";
import {
  handleSuccessfulTrackingCompletion,
} from "./agent-end-terminal.js";
import { runAgentEndGraphRoute } from "./agent-end-graph-route.js";

const activeAgentEndRuns = new Map();

function defineAgentEndStage(definition) {
  return Object.freeze(definition);
}

function createFinalizeSession(context) {
  return async () => {
    if (!context.trackingState || context.didFinalizeSession) return;
    context.didFinalizeSession = true;
    const finalizeMode = context.crashRecoveryResult?.status === "retry_scheduled"
      ? SESSION_FINALIZE_MODE.RETRY_SUSPEND
      : (
          context.event?.synthetic === true
          && context.event?.protocolBoundary === "canonical_outbox_commit"
            ? SESSION_FINALIZE_MODE.SYNTHETIC_COMPLETION
            : SESSION_FINALIZE_MODE.TERMINAL
        );
    await finalizeAgentSession({
      agentId: context.agentId,
      sessionKey: context.sessionKey,
      api: context.api,
      trackingState: context.trackingState,
      logger: context.logger,
      mode: finalizeMode,
    });
  };
}

const AGENT_END_MAIN_STAGES = Object.freeze([
  defineAgentEndStage({
    id: "load_tracking_contract",
    async run(context) {
      if (!context.trackingState?.contract?.path) return;
      const snapshot = await readTrackingContractSnapshot(context.trackingState, context);
      context.contractData = snapshot.contractData;
      context.contractReadDiagnostic = snapshot.diagnostic;
      context.effectiveContractData = context.contractData || context.trackingState?.contract || null;
    },
  }),
  defineAgentEndStage({
    id: "collect_transport",
    async run(context) {
      const transportResult = await handleAgentEndTransport({
        agentId: context.agentId,
        api: context.api,
        logger: context.logger,
        enqueueContract: () => null,
        event: context.event,
        trackingState: context.trackingState,
      });
      context.executionObservation = transportResult.executionObservation || { collected: false };
      context.preserveInbox = transportResult.preserveInbox === true;
      await refreshEffectiveContractDataAfterTransport(context);
    },
  }),
  // ── Marker extraction: parse structured markers from output markdown (Rule 12.2) ──
  // Reads output once, extracts all marker types, merges mutations into single write.
  defineAgentEndStage({
    id: "extract_output_markers",
    match(context) {
      return context.event.success === true
        && Boolean(context.executionObservation?.primaryOutputPath || context.executionObservation?.contractId || context.trackingState?.contract?.id);
    },
    async run(context) {
      const contractId = context.executionObservation?.contractId || context.trackingState?.contract?.id || null;
      if (!contractId) return;

      // Primary: outbox-collected path. Fallback: contract.output field (planner writes there directly).
      let outputPath = context.executionObservation?.primaryOutputPath;
      if (!outputPath) {
        try {
          const snapshot = await readContractSnapshotById(contractId);
          outputPath = snapshot?.output || null;
        } catch {}
      }
      if (!outputPath) return;

      try {
        context._outputContent = await readFile(outputPath, "utf8");
      } catch { return; }

      const rawPlan = buildStagePlanFromMarkers(context._outputContent);
      const stagePlan = rawPlan?.stages?.length > 0
        ? materializeTaskStagePlan({ contractId, stagePlan: { stages: rawPlan.stages } })
        : null;

      const findings = extractFindingMarkers(context._outputContent);
      let reviewerResult = null;
      if (findings.length > 0) {
        const verdict = deriveVerdictFromFindings(findings);
        reviewerResult = buildReviewerResult({
          source: "system_action_review_delivery",
          verdict,
          findings: findings.map((f) => ({
            category: "review",
            severity: f.severity,
            message: f.message,
            evidence: f.evidence.join("; ") || null,
            confidence: f.confidence,
          })),
          continueHint: verdict === "fail" ? "rework" : "continue",
          contractId,
          ts: Date.now(),
        });
      }

      if (stagePlan || reviewerResult) {
        const phases = stagePlan ? stagePlan.stages.map((s) => s.label) : null;
        await mutateContractSnapshot(getContractPath(contractId), context.logger, (c) => {
          if (stagePlan) {
            c.stagePlan = stagePlan;
            c.phases = phases;
          }
          if (reviewerResult) {
            c.reviewerResult = reviewerResult;
          }
        });

        // Propagate stages to tracking state + broadcast so dashboard updates immediately
        if (stagePlan) {
          if (context.trackingState?.contract) {
            context.trackingState.contract.stagePlan = stagePlan;
            context.trackingState.contract.phases = phases;
          }
          broadcast("alert", {
            type: EVENT_TYPE.CONTRACT_STAGE_PLAN_UPDATED,
            contractId,
            phases,
            stagePlan,
            ts: Date.now(),
          });
          context.logger.info(`[agent-end] extracted ${stagePlan.stages.length} stages → contract.stagePlan`);
        }
        if (reviewerResult) context.logger.info(`[agent-end] extracted ${findings.length} findings (verdict: ${reviewerResult.verdict}) → contract.reviewerResult`);
      }
    },
  }),
  // ── Conveyor Belt: graph dispatch runs BEFORE lifecycle evaluation ──
  // If this agent has graph out-edges (= intermediate node), forward the contract
  // immediately and skip all lifecycle stages. Only terminal nodes (no out-edges)
  // proceed to semantic evaluation and delivery.
  defineAgentEndStage({
    id: "graph_route",
    match(context) {
      return Boolean(context.trackingState?.contract?.id)
        && context.event.success === true;
    },
    async run(context) {
      const routeResult = await runAgentEndGraphRoute(context);
      if (!routeResult) {
        return;
      }
      context.graphRouteResult = routeResult;
      if (routeResult.routed || routeResult.owned === true) {
        context.graphOwned = true;
        context.graphRouted = routeResult.routed === true;
        await refreshEffectiveContractDataAfterTransport(context);
        if (context.trackingState?.contract && context.effectiveContractData) {
          context.trackingState.contract = {
            ...context.trackingState.contract,
            ...context.effectiveContractData,
            path: context.trackingState.contract.path,
          };
        }
        if (routeResult.owned === true && routeResult.routed !== true && context.trackingState?.contract?.id) {
          context.preserveInbox = true;
          await routeInbox(context.agentId, context.logger, {
            contractIdHint: context.trackingState.contract.id,
            contractPathHint: context.trackingState.contract.path || null,
          });
        }
      } else if (routeResult.action === "dispatch_failed" || routeResult.action === "fan-out_unsupported") {
        const contractId = context.executionObservation?.contractId || context.trackingState?.contract?.id || null;
        context.logger.warn(`[graph-route] ${routeResult.action} for ${contractId}, falling through to lifecycle`);
      }
    },
  }),
  defineAgentEndStage({
    id: "consume_system_action",
    match(context) { return true; },
    async run(context) {
      if (!context.event.success || !context._outputContent) return;

      const markerActions = extractActionMarkers(context._outputContent);
      const firstAction = markerActions[0] || null;
      if (!firstAction) return;

      // Graph-routed contracts: only allow wake and review actions
      if (context.graphRouted) {
        const ALLOWED_AFTER_GRAPH_ROUTE = new Set(["wake_agent", "request_review"]);
        if (!ALLOWED_AFTER_GRAPH_ROUTE.has(firstAction.type)) {
          context.logger.warn(`[agent-end] blocked [ACTION] ${firstAction.type} after graph_route`);
          return;
        }
      }

      context.logger.info(`[agent-end] [ACTION] marker: ${firstAction.type}${firstAction.params?.targetAgent ? ` → ${firstAction.params.targetAgent}` : ""}`);
      context.systemActionResult = await systemActionConsume({
        agentId: context.agentId,
        sessionKey: context.sessionKey,
        contractData: context.effectiveContractData,
        api: context.api,
        enqueueFn: () => null,
        wakePlanner: context.wakePlanner,
        logger: context.logger,
        injectedAction: firstAction,
      });
    },
  }),
  defineAgentEndStage({
    id: "prepare_tracking_terminal",
    match(context) { return !context.graphOwned; },
    async run(context) {
      const { trackingState } = context;
      if (trackingState) {
        context.isDirectSession = context.isDirectSession
          || isDirectRequestEnvelope(context.effectiveContractData)
          || isDirectRequestEnvelope(trackingState.contract);
      }
    },
  }),
  defineAgentEndStage({
    id: "commit_success_terminal",
    match(context) {
      return !context.graphOwned && Boolean(context.trackingState) && context.event.success === true;
    },
    async run(context) {
      await handleSuccessfulTrackingCompletion(context);
    },
  }),
  defineAgentEndStage({
    id: "crash_recovery",
    async run(context) {
      if (context.event.success) return;
      context.crashRecoveryResult = await handleCrashRecovery({
        agentId: context.agentId,
        sessionKey: context.sessionKey,
        trackingState: context.trackingState,
        error: context.event.error,
        contractReadDiagnostic: context.contractReadDiagnostic,
        api: context.api,
        logger: context.logger,
        maxRetryCount: MAX_RETRY_COUNT,
        retryDelays: RETRY_DELAYS,
      });
      context.didHandleCrashRecovery = true;
    },
  }),
]);

const AGENT_END_FINALLY_STAGES = Object.freeze([
  defineAgentEndStage({
    id: "clear_trace",
    async run(context) {
      clearTrace(context.sessionKey);
    },
  }),
  defineAgentEndStage({
    id: "cleanup_transport",
    async run(context) {
      await cleanupAgentEndTransport({
        agentId: context.agentId,
        api: context.api,
        logger: context.logger,
        preserveInbox: context.preserveInbox,
      });
    },
    onError(context, error) {
      const cleanupMessage = getErrorMessage(error);
      context.logger.error(`[watchdog] cleanupAgentEndTransport failed for ${context.sessionKey}: ${cleanupMessage}`);
      broadcast("alert", {
        type: EVENT_TYPE.RUNTIME_TRANSPORT_CLEANUP_FAILED,
        agentId: context.agentId,
        sessionKey: context.sessionKey,
        contractId: context.trackingState?.contract?.id || context.contractData?.id || null,
        error: cleanupMessage,
        ts: Date.now(),
      });
    },
  }),
  defineAgentEndStage({
    id: "finalize_session",
    async run(context) {
      await context.finalizeSession();
    },
    onError(context, error) {
      const finalizeMessage = getErrorMessage(error);
      context.logger.error(`[watchdog] finalizeAgentSession failed for ${context.sessionKey}: ${finalizeMessage}`);
      broadcast("alert", {
        type: EVENT_TYPE.RUNTIME_FINALIZE_FAILED,
        agentId: context.agentId,
        sessionKey: context.sessionKey,
        contractId: context.trackingState?.contract?.id || context.contractData?.id || null,
        error: finalizeMessage,
        ts: Date.now(),
      });
    },
  }),
]);

export function listAgentEndMainStages() {
  return [...AGENT_END_MAIN_STAGES];
}

function shouldRunStage(stage, context) {
  return typeof stage.match === "function" ? stage.match(context) === true : true;
}

async function runStageList(stages, context, { swallowErrors = false } = {}) {
  for (const stage of stages) {
    if (!shouldRunStage(stage, context)) continue;
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

export function createAgentEndPipelineContext({
  event,
  ctx,
  api,
  logger,
  enqueueFn,
  wakePlanner,
  trackingState,
}) {
  const sessionKey = ctx.sessionKey;
  const agentId = ctx.agentId ?? "unknown";
  const lateCompletionLease = trackingState
    ? consumeLateCompletionLease(trackingState)
    : null;
  const context = {
    event,
    ctx,
    api,
    logger,
    enqueueFn,
    wakePlanner,
    sessionKey,
    agentId,
    trackingState,
    lateCompletionLease,
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

export async function runAgentEndPipeline({
  event,
  ctx,
  api,
  logger,
  enqueueFn,
  wakePlanner,
  trackingState,
}) {
  const sessionKey = ctx?.sessionKey;
  const agentId = ctx?.agentId ?? "unknown";
  const resolvedTrackingState = trackingState || (sessionKey ? getTrackingState(sessionKey) : null);
  const existingRun = sessionKey ? activeAgentEndRuns.get(sessionKey) || null : null;
  if (existingRun) {
    return existingRun;
  }

  const runPromise = (async () => {
    const pipelineContext = createAgentEndPipelineContext({
      event,
      ctx,
      api,
      logger,
      enqueueFn,
      wakePlanner,
      trackingState: resolvedTrackingState,
    });

    try {
      await runAgentEndMainStages(pipelineContext);
    } catch (error) {
      const message = getErrorMessage(error);
      logger.error(`[watchdog] agent_end handler failed for ${sessionKey}: ${message}`);
      broadcast("alert", {
        type: EVENT_TYPE.RUNTIME_AGENT_END_FAILED,
        agentId,
        sessionKey,
        contractId: resolvedTrackingState?.contract?.id || pipelineContext.contractData?.id || null,
        error: message,
        success: event?.success === true,
        ts: Date.now(),
      });

      if (!pipelineContext.didHandleCrashRecovery && event?.success !== true) {
        try {
          await runAgentEndCrashRecoveryFallback(pipelineContext, event?.error || message);
        } catch (recoveryError) {
          const recoveryMessage = getErrorMessage(recoveryError);
          logger.error(`[watchdog] crash recovery failed for ${sessionKey}: ${recoveryMessage}`);
          broadcast("alert", {
            type: EVENT_TYPE.RUNTIME_CRASH_RECOVERY_FAILED,
            agentId,
            sessionKey,
            contractId: resolvedTrackingState?.contract?.id || pipelineContext.contractData?.id || null,
            error: recoveryMessage,
            ts: Date.now(),
          });
        }
      }
    } finally {
      await runAgentEndFinallyStages(pipelineContext);
    }

    return pipelineContext;
  })();

  if (sessionKey) {
    activeAgentEndRuns.set(sessionKey, runPromise);
  }

  try {
    return await runPromise;
  } finally {
    if (sessionKey && activeAgentEndRuns.get(sessionKey) === runPromise) {
      activeAgentEndRuns.delete(sessionKey);
    }
  }
}

// Re-export submodule exports so existing consumers don't break
export {
  refreshEffectiveContractDataAfterTransport,
  mergeRuntimeDiagnostics,
} from "./agent-end-contract-refresh.js";
export {
  normalizePipelineStageDescriptor,
  resolveStageAdvanceSignal,
} from "./agent-end-stage-advance.js";
export {
  handleSuccessfulTrackingCompletion,
} from "./agent-end-terminal.js";
