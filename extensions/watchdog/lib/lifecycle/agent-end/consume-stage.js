import { systemActionConsume } from "../../system-action/system-action-consumer.js";
import { selectPrimarySystemActionResult } from "../../system-action/system-action-runtime-ledger.js";
import { readSessionCollabFacts } from "../../evidence/session-trace-reader.js";
import { recordSynthesizedCollabEvent } from "../../evidence/evidence-bridge.js";
import { TRACE_EVENT_CHANNELS } from "../../evidence/trace-event-schema.js";
import {
  factDedupeKey,
  filterMarkersAgainstTraceFacts,
  synthesizeTraceSystemActionResults,
} from "../../system-action/system-action-trace-merge.js";
import { extractActionMarkers } from "../../security/action-marker-parser.js";

// consume_system_action 的执行体（自 stage-definitions.js 逐行原样搬出，match() 留在清单里）。
export async function runConsumeSystemActionStage(context) {
  if (!context.event.success) return;

  // B5 两源合流(spec §8):L1 工具中场已执行的协作动作从会话 trace 读事实
  // (不重派),按票据账本现状刷新 deferred 语义;文本 [ACTION] 照常提取,
  // 与已执行事实同 (intent,target) 的标记跳过。trace 缺失 → 空合成,现行为。
  const collabFacts = await readSessionCollabFacts(context.sessionKey, {
    contractId: context.effectiveContractData?.id || context.trackingState?.contract?.id || null,
  });
  const synthesizedResults = await synthesizeTraceSystemActionResults(collabFacts);
  if (synthesizedResults.length > 0) {
    context.logger.info(`[agent-end] ${synthesizedResults.length} collab action(s) already executed mid-session (from trace)`);
  }

  // FIX(B7-structured-dispatch): pass the per-session provenance nonce so
  // echoed/quoted user content cannot forge a privileged [ACTION]. The nonce
  // stays null until SOUL injection populates contract.provenanceNonce
  // (integration-only), so today's behavior is preserved verbatim.
  const sessionNonce = context.trackingState?.contract?.provenanceNonce
    || context.effectiveContractData?.provenanceNonce
    || null;
  const extractedMarkers = context._outputContent
    ? extractActionMarkers(context._outputContent, { sessionNonce })
    : [];
  const markerActions = filterMarkersAgainstTraceFacts(extractedMarkers, collabFacts);
  if (markerActions.length < extractedMarkers.length) {
    context.logger.info(`[agent-end] ${extractedMarkers.length - markerActions.length} [ACTION] marker(s) skipped — already executed via collab FC`);
  }

  // Graph-routed contracts: only allow wake actions. Blocked
  // markers are logged and skipped (not recorded), matching the single-slot
  // behavior — a disallowed marker must not flip the terminal ladder.
  const ALLOWED_AFTER_GRAPH_ROUTE = new Set(["wake_agent"]);
  const actionsToRun = context.graphRouted
    ? markerActions.filter((action) => {
      if (ALLOWED_AFTER_GRAPH_ROUTE.has(action.type)) return true;
      context.logger.warn(`[agent-end] blocked [ACTION] ${action.type} after graph_route`);
      return false;
    })
    : markerActions;

  // 同 (type,target) 的重复标记收敛为首个:输出里回显/复读的同一动作
  // 不应产生第二次派发(live 观测:planner 简报回显任务文本 3 次)。
  const seenActionKeys = new Set();
  const dedupedActions = actionsToRun.filter((action) => {
    const key = factDedupeKey(action.type, action.params?.targetAgent);
    if (seenActionKeys.has(key)) {
      context.logger.info(`[agent-end] duplicate [ACTION] ${key} collapsed`);
      return false;
    }
    seenActionKeys.add(key);
    return true;
  });

  const systemActionResults = [...synthesizedResults];
  const traceContractId = context.executionObservation?.contractId
    || context.trackingState?.contract?.id
    || null;
  for (const action of dedupedActions) {
    context.logger.info(`[agent-end] [ACTION] marker: ${action.type}${action.params?.targetAgent ? ` → ${action.params.targetAgent}` : ""}`);
    const result = await systemActionConsume({
      agentId: context.agentId,
      sessionKey: context.sessionKey,
      contractData: context.effectiveContractData,
      api: context.api,
      logger: context.logger,
      injectedAction: action,
    });
    if (result) {
      systemActionResults.push(result);
      // OMIT-01 文本路入账:经文本标记执行的协作动作合成 kind:collab 事件
      // 进同一本账,考官免于跨 contract.systemAction 补看。trace 合流来的
      // synthesizedResults 本就源自账本,统统免除重复记账。close 哨兵由
      // 主段末尾的 close_session_trace 写(本段之后、commit 之前,STOP-03
      // 前移)→ 合成事件先于 close 落账仍然成立(顺序真值见
      // AGENT_END_MAIN_STAGES,单测有序护栏)。
      await recordSynthesizedCollabEvent({
        sessionKey: context.sessionKey,
        agentId: context.agentId,
        // 解析层现返回纯 intent(未带通道字段);fence 通道在 nonce 接线前
        // inert,缺省按 text 入账,解析层补 channel 后此处自动跟随。
        channel: action.channel === TRACE_EVENT_CHANNELS.FENCE
          ? TRACE_EVENT_CHANNELS.FENCE
          : TRACE_EVENT_CHANNELS.TEXT,
        name: action.type,
        args: action.params || {},
        result,
        contractId: traceContractId,
        logger: context.logger,
      });
    }
  }
  if (systemActionResults.length === 0) return;
  context.systemActionResults = systemActionResults;
  context.systemActionResult = selectPrimarySystemActionResult(systemActionResults);
}
