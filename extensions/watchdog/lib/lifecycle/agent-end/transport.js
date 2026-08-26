import { join } from "node:path";
import { collectOutbox } from "../../routing/mailbox/runtime-mailbox.js";
import { cleanInbox, getMailboxWorkspace } from "../../routing/mailbox/runtime-mailbox-transport.js";
import { snapshotInboxToRunTree, snapshotOutputToRunTree } from "../run-tree-snapshot.js";
import { materializeExecutionObservation } from "../../stage/execution-observation.js";
import {
  isDirectRequestEnvelope,
  resolveDirectRequestEnvelopeSessionKey,
} from "../../protocol/protocol-primitives.js";
import {
  RUNTIME_WAKE_SEMANTICS,
  runtimeWakeAgentDetailed,
} from "../../transport/runtime-wake-transport.js";
import { wireCollected } from "../../archive/run-event-wiring.js";
import { extractFinalAssistantText } from "../../delivery/runtime-user-facing-output.js";

// 消息面交付的流程就绪门。合约轮里 agent 从未成功读到自己的 inbox/contract.json
// (ownInboxContractReadAt = before-tool-call 1b 闸的同一真值)= 它根本不知道本轮任务
// 是什么,此时的正文是受阻说明而非交付——物化它会把"我干不了这活"封成合格交付物
// (live 实证 2026-08-18 TC-…495631:失败说明被判 completed=假成功)。
// 判据是平台自证的流程事实,不看正文长相(内容启发式不进判定层,2026-08-17 拆分裁定)。
// 非合约轮无此前提,与 1b 闸放行条件对称。
export function resolveMessageDeliverableText({ event, trackingState }) {
  if (trackingState?.contract?.id && !Number.isFinite(trackingState?.ownInboxContractReadAt)) {
    return null;
  }
  return extractFinalAssistantText(event?.messages);
}

export async function handleAgentEndTransport({
  agentId,
  api,
  logger,
  enqueueContract,
  event = null,
  trackingState = null,
}) {
  // 会话起点下传:采集侧据此判"本轮产物 vs 上一轮残件"(live 复现 2026-08-05:
  // 上一轮缺 runtime_result 早退留下的 md,会被本轮无归属采走并入包污染下游)。
  const collectedTransport = await collectOutbox(agentId, logger, {
    sessionStartMs: Number(trackingState?.startMs) || 0,
    // submit_output(L1 工具)本轮的声明。它优先于 outbox/runtime_result.json(L3 文件),
    // 两者都缺时采集按产物证据自行推断。
    declaredOutput: trackingState?.submittedOutput || null,
    // 绑定信封的合约 id:inbox/contract.json 会被清道夫在 turn 中途删掉
    // (hooks/after-tool-call.js Read+10s),文件缺席时采集侧凭它回读共享正本。
    boundContractId: trackingState?.contract?.id || null,
    // 树模式采集封包(seal.json)记会话归属用
    sessionKey: trackingState?.sessionKey || null,
    // 崩溃轮下传(event.success === false 即崩溃轮):seal 是终局凭据,
    // 只在本轮成功收官时封——崩溃轮封条会让 crash-retry 重跑被幂等短路。
    turnSucceeded: event?.success !== false,
    // 消息面缺省交付的正文源:收官轮最后一段 assistant 正文。零文件轮由采集侧
    // 物化成 message.md——agent 的语义世界只有"直接回复",落盘是平台记账。
    messageText: resolveMessageDeliverableText({ event, trackingState }),
  });
  const executionObservation = materializeExecutionObservation(collectedTransport);
  // 事件接线(批② §八):agent_end 采集完成 = collected 时刻(成败都记账,payload 带判定)。
  void wireCollected({
    contract: trackingState?.contract,
    agentId,
    sessionKey: trackingState?.sessionKey,
    collected: executionObservation.collected === true,
    deliverableKind: collectedTransport?.messageDeliverable === true ? "message" : null,
    logger,
  });
  if (executionObservation.collected) {
    logger.info(`[watchdog] collectOutbox(${agentId}): success`);

    // DRAFT lifecycle eliminated — dispatch-graph-policy handles all forwarding.
  } else if (executionObservation.error) {
    // executionObservation.error 的唯一消费方：采集失败的原因到此为止就会被丢弃，
    // 落一条 agent_end 日志，让"这一轮为什么没产物"在事后可追。
    logger?.warn?.(
      `[watchdog] collectOutbox(${agentId}): nothing collected — ${executionObservation.error}`,
    );
  }

  return { executionObservation };
}

export async function cleanupAgentEndTransport({
  agentId,
  api = null,
  logger,
  preserveInbox = false,
  trackingState = null,
  executionObservation = null,
}) {
  // 产出件快照到 run 树（旁路补充，绝不破坏清理）。与 inbox 快照同邻域，
  // 但独立于 inbox 保留分支：无论 preserveInbox 与否都尝试快照，让 delivery
  // 在 live 产出件被清后能回退读到最终件。整段 try/catch 吞错，不冒泡。
  try {
    const contractId = trackingState?.contract?.id || null;
    const outputPath = executionObservation?.primaryOutputPath || trackingState?.contract?.output || null;
    if (contractId && outputPath) {
      await snapshotOutputToRunTree({
        lineage: trackingState?.contract?.lineage || null,
        contractId,
        agentId,
        outputPath,
      });
    }
  } catch (outputSnapshotError) {
    logger?.warn?.(`[watchdog] snapshotOutputToRunTree(${agentId}) skipped: ${outputSnapshotError?.message || outputSnapshotError}`);
  }
  if (preserveInbox) {
    return {
      cleaned: false,
      preserved: true,
      preserveReason: "explicit_preserve",
      promotedDirectEnvelope: null,
      wake: null,
    };
  }

  // 清理前快照 inbox 过滤副本到 run 树（旁路补充，绝不破坏清理）。
  // 整段 try/catch 吞错：快照失败不得影响后续 unlink。
  try {
    const contractId = trackingState?.contract?.id || null;
    const workspace = getMailboxWorkspace(agentId);
    if (contractId && workspace) {
      await snapshotInboxToRunTree({
        lineage: trackingState?.contract?.lineage || null,
        contractId,
        agentId,
        inboxDir: join(workspace, "inbox"),
      });
    }
  } catch (snapshotError) {
    logger?.warn?.(`[watchdog] snapshotInboxToRunTree(${agentId}) skipped: ${snapshotError?.message || snapshotError}`);
  }

  const cleanupResult = await cleanInbox(agentId, logger, {
    ownerContractId: trackingState?.contract?.id || null,
  });
  if (cleanupResult?.preserved === true) {
    return {
      cleaned: false,
      preserved: true,
      preserveReason: cleanupResult.preserveReason || "preserved",
      promotedDirectEnvelope: null,
      wake: null,
    };
  }
  const promotedDirectEnvelope = cleanupResult?.promotedDirectEnvelope || null;
  let wake = null;

  if (
    api
    && promotedDirectEnvelope
    && isDirectRequestEnvelope(promotedDirectEnvelope)
  ) {
    const targetSessionKey = resolveDirectRequestEnvelopeSessionKey(promotedDirectEnvelope);
    wake = await runtimeWakeAgentDetailed(
      agentId,
      null,
      api,
      logger,
      {
        ...(targetSessionKey ? { sessionKey: targetSessionKey } : {}),
        wakeSemantic: RUNTIME_WAKE_SEMANTICS.DIRECT_REQUEST_RESUME,
        envelopeId: promotedDirectEnvelope.id,
      },
    );
  }

  return {
    cleaned: cleanupResult?.cleaned === true,
    preserved: false,
    preserveReason: null,
    promotedDirectEnvelope,
    wake,
  };
}
