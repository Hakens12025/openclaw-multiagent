import { readFile } from "node:fs/promises";

import { broadcast } from "../transport/sse.js";
import { EVENT_TYPE } from "../core/event-types.js";
import {
  cleanupAgentEndTransport,
  handleAgentEndTransport,
} from "./agent-end-transport.js";
import { archiveAgentSession } from "./session-archive.js";
import { saveAgentArtifact } from "./artifact-store.js";
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
import {
  MAX_RETRY_COUNT, RETRY_DELAYS,
} from "../state.js";
import {
  refreshEffectiveContractDataAfterTransport,
} from "./agent-end-contract-refresh.js";
import { mutateContractSnapshot, getContractPath } from "../contracts.js";
import { routeInbox } from "../../runtime-mailbox.js";
import {
  handleSuccessfulTrackingCompletion,
} from "./agent-end-terminal.js";
import { runAgentEndGraphRoute } from "./agent-end-graph-route.js";
import {
  readTrackingContractSnapshot,
} from "./agent-end-contract-refresh.js";
import { getErrorMessage } from "../core/normalize.js";

function defineAgentEndStage(definition) {
  return Object.freeze(definition);
}

function graphRouteOwnsLifecycle(routeResult) {
  if (!routeResult || typeof routeResult !== "object") {
    return false;
  }
  if (routeResult.routed === true) {
    return true;
  }
  const ownedActions = new Set([
    "queued",
    "dispatched",
    "output_commit_observed",
  ]);
  if (ownedActions.has(routeResult.action)) {
    return true;
  }
  if (routeResult.owned === true && routeResult.terminalOutcome) {
    return true;
  }
  if (routeResult.action === "terminal" || routeResult.action === "direct_request") {
    return false;
  }
  return false;
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

export { createFinalizeSession };

export const AGENT_END_MAIN_STAGES = Object.freeze([
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
    // 只在 success=true 时提取 marker：失败的 agent 产出的是错误信息而非有效 marker。
    // 需有可定位的 contract（primaryOutputPath / contractId / trackingState.contract.id 任一）；
    // run() 内对 null contractId/output 有兜底 return，故此 match 只做粗筛。
    match(context) {
      return context.event.success === true
        && Boolean(context.executionObservation?.primaryOutputPath || context.executionObservation?.contractId || context.trackingState?.contract?.id);
    },
    async run(context) {
      const contractId = context.executionObservation?.contractId || context.trackingState?.contract?.id || null;
      if (!contractId) return;

      const outputPath = context.executionObservation?.primaryOutputPath || null;
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
  // ── 产物整包独立保存（在 graph_route 派发下一环之前）──────────────────────────
  // 把本环 agent 的【全部】产物文件整包存到 control-plane/artifacts/<cid>/<producer>/
  // + manifest.json（决策见 docs/decision-dual-file-package-flow-2026-05-31.md）。
  // 产出件此时已就绪（collect_transport 已 materialize，executionObservation.artifactPaths 可用）。
  // 放在 graph_route 之前 = 派发下一环前就存好，下游 routeInbox 可整包流入其 inbox。
  // saveAgentArtifact 内部已 try/catch；此处再包一层，失败仅 warn，绝不中断主链。
  defineAgentEndStage({
    id: "preserve_artifact",
    async run(context) {
      try {
        const contractId = context.trackingState?.contract?.id || null;
        const obs = context.executionObservation || {};
        const primaryOutputPath = obs.primaryOutputPath
          || context.trackingState?.contract?.output
          || null;
        // 多文件产物走 outbox → artifactPaths；单交付物直接写到 contract.output
        // （WebUI 链路）→ artifactPaths 为空，回退到 primaryOutputPath，同样打包流转。
        let artifactPaths = Array.isArray(obs.artifactPaths) ? obs.artifactPaths.filter(Boolean) : [];
        if (artifactPaths.length === 0 && primaryOutputPath) {
          artifactPaths = [primaryOutputPath];
        }
        if (contractId && artifactPaths.length > 0) {
          await saveAgentArtifact({
            contractId,
            agentId: context.agentId,
            artifactPaths,
            primaryOutputPath,
            status: obs.stageCompletion?.status || "completed",
            summary: obs.stageRunResult?.summary || null,
          });
        }
      } catch (artifactError) {
        context.logger?.warn?.(`[watchdog] saveAgentArtifact(${context.agentId}) skipped: ${getErrorMessage(artifactError)}`);
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
      if (graphRouteOwnsLifecycle(routeResult)) {
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
        if (routeResult.routed !== true && context.trackingState?.contract?.id) {
          context.preserveInbox = true;
          await routeInbox(context.agentId, context.logger, {
            contractIdHint: context.trackingState.contract.id,
            contractPathHint: context.trackingState.contract.path || null,
          });
        }
      } else if (routeResult.action === "dispatch_failed") {
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

export const AGENT_END_FINALLY_STAGES = Object.freeze([
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
        trackingState: context.trackingState,
        executionObservation: context.executionObservation,
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
    id: "archive_session",
    // 持久归档当前 session（只读观测档，供「工作流」页看历史）。
    // 会话 .jsonl 在 agents/ 下、不被 cleanupAgentEndTransport 清，归档时仍在。
    // archiveAgentSession 内部已 try/catch 吞错；此处再包一层兜底，
    // 任何失败绝不冒泡破坏 agent_end finally 链。
    async run(context) {
      try {
        await archiveAgentSession({
          agentId: context.agentId,
          sessionKey: context.sessionKey,
          contractId: context.trackingState?.contract?.id || context.contractData?.id || null,
        });
      } catch (archiveError) {
        context.logger?.warn?.(`[watchdog] archiveAgentSession(${context.agentId}) skipped: ${getErrorMessage(archiveError)}`);
      }
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
