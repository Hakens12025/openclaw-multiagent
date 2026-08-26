import { broadcast } from "../../transport/sse.js";
import { EVENT_TYPE } from "../../core/event-types.js";
import {
  cleanupAgentEndTransport,
  handleAgentEndTransport,
} from "./transport.js";
import { archiveSessionToRunTree } from "../run-tree-archive.js";
import { isDirectRequestEnvelope } from "../../protocol/protocol-primitives.js";
import {
  finalizeAgentSession,
  SESSION_FINALIZE_MODE,
} from "../runtime-lifecycle.js";
import { handleCrashRecovery } from "../crash-recovery.js";
import { clearTrace } from "../../store/execution-trace-store.js";
import { closeSessionTrace } from "../../evidence/session-trace-store.js";
import {
  MAX_RETRY_COUNT, RETRY_DELAYS,
} from "../../state.js";
import {
  refreshEffectiveContractDataAfterTransport,
} from "./contract-refresh.js";
import {
  handleSuccessfulTrackingCompletion,
} from "./terminal.js";
import { runGraphRouteStage } from "./graph-route.js";
import { runExtractOutputMarkersStage } from "./markers-stage.js";
import { runConsumeSystemActionStage } from "./consume-stage.js";
import {
  readTrackingContractSnapshot,
} from "./contract-refresh.js";
import { getErrorMessage } from "../../core/normalize.js";

function defineAgentEndStage(definition) {
  return Object.freeze(definition);
}

// ── 账本收官助手(主段正路与 finally backstop 共用)──────────────────────────
// close 留在主段末尾、**不能退回 finally**:合成 collab 事件必须先落账才算数,
// synthesized-collab-events 钉死 extract_output_markers < close_session_trace 与
// consume_system_action < close_session_trace 两条顺序。(判决面已于 2026-08-09
// 拔除,原先"判决须先于 commit 落账"那条理由随之作废,但顺序约束本身仍在。)
// 助手自带吞错——捕获面严格弱于执行面,任何失败只 warn。
// 旗标在尝试前立起(attempt-once 语义)。
async function runCloseSessionTraceStage(context) {
  context.evidenceTraceClosed = true;
  try {
    await closeSessionTrace(context.sessionKey, { success: context.event?.success === true });
  } catch (error) {
    context.logger?.warn?.(`[watchdog] closeSessionTrace(${context.sessionKey}) failed (non-blocking): ${getErrorMessage(error)}`);
  }
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
      // context.preserveInbox 只有一个置真写入方:graph_route 阶段没路由出去时置 true
      // (`graph-route.js` 的 routeResult.routed !== true 分支;初值 false 在 `lifecycle.js`),
      // 保住这份没送出去的 contract 的 inbox。采集侧不再参与该判定。
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
      await runExtractOutputMarkersStage(context);
    },
  }),
  // preserve_artifact 站已退役(2026-08-19):它把本环产物再抄一份进
  // control-plane/artifacts/<cid>/<producer>/,作为下游取包的第二数据源。
  // 采集侧封条(seal)落地后,树 outbox 就是不可变正本,下游一律直接链/拷树内那一份;
  // 这个副本店从 2026-08-16 起再没被读过,只剩单测垃圾在里面堆。
  // 下游取包见 lib/delivery/upstream-package-inflow.js 的 copyUpstreamArtifactsToInbox。
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
      await runGraphRouteStage(context);
    },
  }),
  defineAgentEndStage({
    id: "consume_system_action",
    match(context) { return true; },
    async run(context) {
      await runConsumeSystemActionStage(context);
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
  // ── 证据收官前移(STOP-03):close 哨兵 → 考官判决,落在 commit_success_terminal
  // 之前——automation 收轮(commit 内 handleAutomationContractTerminal →
  // finalizeAutomationRound)读判决库时,当轮判决已成账。前移安全性已核实:
  //   ① 本点之后的主段/finally 段无任何 trace 写者(全库写者仅 before/after-
  //     tool-call 钩子与上方 consume/extract 两段),close 提前截断不了证据;
  //   ② 考官读的 effectiveContractData 是 commit 前的磁盘快照克隆(contract-store
  //     cloneSnapshot),commit 的字段合并本就不进考官视野——判决输入逐项不变。
  // 失败路(success=false)与 graph-owned 会话同样在此收官,与旧 finally 语义一致。
  defineAgentEndStage({
    id: "close_session_trace",
    match(context) { return Boolean(context.trackingState); },
    async run(context) {
      await runCloseSessionTraceStage(context);
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
  // ── 账本收官 backstop:正路在主段末尾(见 close_session_trace)。此处只兜主段
  // 早夭——前序 stage 抛错短路时仍保证 close 哨兵恰好执行一次(context 旗标防重入)。
  // finally 段 swallowErrors + 助手自吞错,双保险维持"永不影响执行面"。──────
  defineAgentEndStage({
    id: "close_session_trace_backstop",
    match(context) {
      return Boolean(context.trackingState) && context.evidenceTraceClosed !== true;
    },
    async run(context) {
      await runCloseSessionTraceStage(context);
    },
  }),
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
    // 持久归档当前 session 到合约所在 run 树（只读观测档，供「工作流」页看历史）。
    // 会话 .jsonl 在 agents/ 下、不被 cleanupAgentEndTransport 清，归档时仍在。
    // 无谱系（=无合约轮次）无 run 家，归档器内部跳过并 debug 留痕。
    // archiveSessionToRunTree 内部已 try/catch 吞错；此处再包一层兜底，
    // 任何失败绝不冒泡破坏 agent_end finally 链。
    async run(context) {
      try {
        await archiveSessionToRunTree({
          agentId: context.agentId,
          sessionKey: context.sessionKey,
          lineage: context.trackingState?.contract?.lineage || context.contractData?.lineage || null,
          logger: context.logger,
        });
      } catch (archiveError) {
        context.logger?.warn?.(`[watchdog] archiveSessionToRunTree(${context.agentId}) skipped: ${getErrorMessage(archiveError)}`);
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
