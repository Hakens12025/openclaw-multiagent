import { CONTRACT_STATUS } from "../../core/runtime-status.js";
import {
  routeAfterAgentEnd,
  resolveRouteAfterAgentEndTarget,
} from "../../routing/dispatch/dispatch-graph-policy.js";
import { isSessionHardStopped, getSessionHardStopReason, HARD_STOP_REASON } from "../../runtime/execution-hard-stop-registry.js";
import { buildHardStopSummary, HARD_STOP_TERMINAL_SOURCE } from "../../runtime/hard-stop-terminalize.js";
import { resolveSessionEpochKey } from "../../runtime/session-epoch-key.js";
import { refreshEffectiveContractDataAfterTransport } from "./contract-refresh.js";
import { applyContractLineageToTracking } from "../../contract/contract-lineage.js";
import { routeInbox } from "../../routing/mailbox/runtime-mailbox.js";
import { getSessionProgress } from "../../evidence/session-progress-projection.js";
import { isDirectRequestEnvelope } from "../../protocol/protocol-primitives.js";

function getRuntimeTraceVerdict(context, contractData) {
  return getSessionProgress(context?.sessionKey)
    || contractData?.runtimeDiagnostics?.executionTrace
    || context?.trackingState?.contract?.runtimeDiagnostics?.executionTrace
    || null;
}

// 执行硬停闸(重复调用/工具预算/输出预算/人工终止),与图回路无关。
// 只回答「本会话被硬停了吗」,并给出**未交付时**的终态。文案与 source 都引
// hard-stop-terminalize(正版)的导出,不再在本文件维护平行拷贝——过去这里自带一份
// `session hard-stopped (…) before final output was committed` 的硬编码 summary,
// 与正版分表对同一 reason 给不同结论。
function resolveHardStopTerminalGate(context, contractData) {
  const epochKey = resolveSessionEpochKey(context?.trackingState) || context?.sessionKey;
  if (!isSessionHardStopped(epochKey)) {
    return null;
  }
  const outputPath = String(
    contractData?.output
    || context?.trackingState?.contract?.output
    || "",
  ).trim();
  const hardStopReason = getSessionHardStopReason(epochKey) || HARD_STOP_REASON.UNSPECIFIED;
  return {
    routed: false,
    owned: false,
    action: "terminal",
    reason: hardStopReason,
    target: null,
    terminalOutcome: {
      status: CONTRACT_STATUS.FAILED,
      source: HARD_STOP_TERMINAL_SOURCE,
      reason: hardStopReason,
      summary: buildHardStopSummary(hardStopReason),
      artifact: outputPath || null,
    },
  };
}

// 交接门已随判决面重做整体删除(2026-08-10)。它自 cut1 起就恒弃权(hasProtocolSemanticPayload
// 判 stageRunResult 存在即放行,而采集侧无条件合成 stageRunResult)——实测 3 字节产物照样
// 转发,门在测试里活着、生产里死着。产物是否够格归 lib/judgment 对甲方期望核对;
// 转发本身只看事实(收口状态),不再有内容质量门。

export async function runAgentEndGraphRoute(context) {
  const contractData = context.effectiveContractData || context.trackingState?.contract || null;
  const contractId = context.executionObservation?.contractId || context.trackingState?.contract?.id || null;
  if (!contractId || !context.event?.success) {
    return null;
  }
  if (isDirectRequestEnvelope(contractData) || isDirectRequestEnvelope(context.trackingState?.contract)) {
    return {
      routed: false,
      action: "direct_request",
      target: null,
    };
  }
  if (
    context.event?.protocolBoundary === "canonical_outbox_commit"
    && context.event?.commitType === "output_commit"
  ) {
    return {
      routed: false,
      owned: true,
      action: "output_commit_observed",
      target: null,
    };
  }

  // 回路运行时退役(2026-08-18):此处曾有一条按 contract.pipelineStage 分流的回路推进
  // 支路,它的硬停闸没有逃生口(硬停即 terminal),与下面这条普通图路由的
  // 「硬停 + outputCommitted 事实 → 不判失败」不一致。回路面消失后统一到普通图路由这一侧:
  // 硬停只在 agent 没把产物提交完的情况下截停;已提交事实(executionTrace.outputCommitted)
  // 说明这一跳的交付是完整的,截停它等于凭"会话被判重复"丢掉一份真产物。
  const resolvedRoute = await resolveRouteAfterAgentEndTarget(context.agentId, {
    status: "completed",
  });
  const forwardable = resolvedRoute.routable === true && Boolean(resolvedRoute.target);
  const hardStopGate = resolveHardStopTerminalGate(context, contractData);
  if (hardStopGate) {
    const traceVerdict = getRuntimeTraceVerdict(context, contractData);
    // 两段判断,顺序不能倒(旧版是 outputCommitted && routable && target 三条件与运算,
    // 把「终点节点」当成「没交付」——终点节点 routable=false,产物提交了照样收 FAILED,
    // 文案还写 "before final output was committed",与事实相反):
    //   ① 终态是否成功 —— 只看 outputCommitted 这一个事实,与本节点有没有出边无关;
    //   ② 是否转发 —— 交付完整**且**图上还有下一跳才转发。
    if (traceVerdict?.outputCommitted !== true) {
      return hardStopGate;
    }
    if (!forwardable) {
      // 终点节点:没有下一跳不等于交付失败。不带 terminalOutcome 返回,
      // 收口交回 terminal.js → resolveTerminalOutcome 正版分表(按盘上事实结算
      // status 与 artifact),硬停 reason 只作为路由决定的留痕。
      return {
        routed: false,
        owned: false,
        action: "terminal",
        reason: hardStopGate.reason,
        target: null,
      };
    }
  }
  if (forwardable) {
    return routeAfterAgentEnd(context.agentId, contractId, {
      status: "completed",
      api: context.api,
      logger: context.logger,
      targetAgent: resolvedRoute.target,
    });
  }

  // 不可路由:routeAfterAgentEnd 在这条分支上只会原样回吐已解出的路线
  // (dispatch-graph-policy.js:485-487),再调一次等于白跑第二次 loadGraph。
  return { routed: false, action: resolvedRoute.action, target: resolvedRoute.target || null };
}

// ── graph_route 站的执行体(自 stage-definitions 原样迁出,机器与站体同盒)────────

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
  // 其余 action(terminal / direct_request / ambiguous_runtime_transition /
  // unauthorized_explicit_target / dispatch_failed)一律不归 graph_route 管生命周期,
  // 落回 terminal 站收口。
  return false;
}

export async function runGraphRouteStage(context) {
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
      // 批① 谱系刷新性回填:谱系建约即定、终身不变 → 初绑已回填时此处幂等重写同值。
      applyContractLineageToTracking(context.trackingState, context.effectiveContractData);
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
}
