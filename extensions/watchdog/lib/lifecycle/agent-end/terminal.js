import {
  buildDeferredSystemActionFollowUp,
  deriveSystemActionTerminalOutcome,
  isDeferredSystemActionAccepted,
  normalizeSystemActionResults,
  selectPrimarySystemActionResult,
} from "../../system-action/system-action-runtime-ledger.js";
import {
  commitSemanticTerminalState,
  mergeTrackingContractFields,
} from "../../routing/terminal-commit.js";
import { normalizeTerminalOutcome, resolveTerminalOutcome } from "../../contract/terminal-outcome.js";
import { writeDeliveryTicket } from "../../routing/delivery/delivery-ticket-store.js";
import { executeDeliveryTicketPayload, pokeDeliveryPump } from "../../routing/delivery/delivery-pump.js";
import { broadcast } from "../../transport/sse.js";
import { EVENT_TYPE } from "../../core/event-types.js";
import { getSessionProgress } from "../../evidence/session-progress-projection.js";
import {
  CONTRACT_STATUS,
  SYSTEM_ACTION_STATUS,
  isTerminalContractStatus,
} from "../../core/runtime-status.js";
import { materializeExecutionObservation } from "../../stage/execution-observation.js";
import { mergeRuntimeDiagnostics } from "./contract-refresh.js";
import { buildOutputIoObservation, mergeIoObservation } from "../../stage/io-observation.js";
import { getExecutionIncident } from "../../runtime/execution-incident-store.js";
import { resolveSessionEpochKey } from "../../runtime/session-epoch-key.js";
import { readContractSnapshotById } from "../../contract/contracts.js";
import { wireClosed, wireTicketWritten } from "../../archive/run-event-wiring.js";

function buildIncidentClarification(executionIncident) {
  if (!executionIncident?.rootFault) {
    return null;
  }
  const parts = [
    executionIncident.rootFault,
    executionIncident.firstFaultCode || null,
  ];
  if (Array.isArray(executionIncident.amplifiers) && executionIncident.amplifiers.length > 0) {
    parts.push(`amplifiers=${executionIncident.amplifiers.join(",")}`);
  }
  return `runtime incident: ${parts.filter(Boolean).join(" / ")}`;
}

function applyExecutionIncidentToTerminalOutcome(terminalOutcome, executionIncident) {
  if (!terminalOutcome || !executionIncident?.rootFault) {
    return terminalOutcome;
  }

  return normalizeTerminalOutcome({
    ...terminalOutcome,
    reason: executionIncident.terminationReason
      || executionIncident.firstFaultCode
      || terminalOutcome.reason,
    clarification: [
      terminalOutcome.clarification,
      buildIncidentClarification(executionIncident),
    ].filter(Boolean).join(" | ") || null,
  }, {
    terminalStatus: terminalOutcome.status,
  });
}

// 单会话多动作:contract.systemAction 持久化为条目数组(entry 形状不变),
// followUp 保持单对象(取主 deferred),lifecycle-view 的 shape-read 不受影响。
export function buildSystemActionContractFields(systemActionResults, {
  deferredFollowUp = null,
} = {}) {
  const entries = normalizeSystemActionResults(systemActionResults)
    .filter((result) => result.status !== SYSTEM_ACTION_STATUS.NO_ACTION)
    .map((result) => ({
      type: result.actionType || null,
      status: result.status || null,
      targetAgent: result.targetAgent || null,
      contractId: result.contractId || null,
      error: result.error || null,
      retryable: result.status === SYSTEM_ACTION_STATUS.BUSY,
      wake: result.wake || null,
      ts: Date.now(),
    }));
  if (entries.length === 0) {
    return {};
  }

  return {
    systemAction: entries,
    ...(deferredFollowUp ? { followUp: deferredFollowUp } : {}),
  };
}

function markDuplicateTerminalTrackingState(trackingState, terminalStatus, terminalOutcome = null) {
  if (!trackingState) return;
  const effectiveTerminalStatus = isTerminalContractStatus(terminalStatus)
    ? terminalStatus
    : CONTRACT_STATUS.COMPLETED;
  trackingState.status = effectiveTerminalStatus;
  trackingState.lastLabel = `已收口（重复${effectiveTerminalStatus}）`;
  if (!trackingState.contract) return;
  trackingState.contract.status = effectiveTerminalStatus;
  if (terminalOutcome) {
    trackingState.contract.terminalOutcome = terminalOutcome;
  }
  trackingState.pct = 100;
  trackingState.cursor = `${trackingState.contract.total}/${trackingState.contract.total}`;
  trackingState.estimatedPhase = effectiveTerminalStatus === CONTRACT_STATUS.COMPLETED
    ? "已完成"
    : effectiveTerminalStatus;
}

function resolveGraphTerminalOutcome(graphRouteResult) {
  if (!graphRouteResult?.terminalOutcome) {
    return null;
  }
  const terminalOutcome = normalizeTerminalOutcome(
    graphRouteResult.terminalOutcome,
    {
      terminalStatus: graphRouteResult.terminalOutcome.status || CONTRACT_STATUS.COMPLETED,
    },
  );
  return {
    terminalOutcome,
    terminalStatus: terminalOutcome.status,
  };
}

export async function handleSuccessfulTrackingCompletion(context) {
  const {
    agentId,
    logger,
    executionObservation,
    systemActionResult,
    trackingState,
    effectiveContractData,
  } = context;
  const duplicateTerminalContract = isTerminalContractStatus(effectiveContractData?.status);
  const runtimeDiagnostics = {};
  let effectiveContractForOutcome = effectiveContractData || trackingState?.contract || null;
  let effectiveExecutionObservation = materializeExecutionObservation(executionObservation, {
    contractId: effectiveContractForOutcome?.id || trackingState?.contract?.id || null,
    fallbackPrimaryOutputPath: effectiveContractForOutcome?.output || trackingState?.contract?.output || null,
  });
  context.executionObservation = effectiveExecutionObservation;

  const traceVerdict = getSessionProgress(context.sessionKey);
  const executionIncident = getExecutionIncident({
    contractId: effectiveContractForOutcome?.id || trackingState?.contract?.id || null,
    epochKey: resolveSessionEpochKey(trackingState) || context.sessionKey,
    sessionKey: context.sessionKey,
  });
  if (traceVerdict) {
    runtimeDiagnostics.executionTrace = traceVerdict;
    effectiveContractForOutcome = {
      ...(effectiveContractForOutcome || {}),
      runtimeDiagnostics: mergeRuntimeDiagnostics(
        effectiveContractForOutcome?.runtimeDiagnostics,
        { executionTrace: traceVerdict },
      ),
    };
    if (traceVerdict.offTrack) {
      logger.warn(`[watchdog] TRACE OFF-TRACK: ${context.sessionKey} — ${traceVerdict.totalCalls} calls, output not committed`);
    }
  }

  // 账物分离 batch2:contractRead / lateCompletion 是零读者取证子字段,不再写正本。
  //   - contractRead:成功收口这份从不被读;唯一消费者是 crash-recovery 自己重试写点
  //     落的那份(lib/lifecycle/crash-recovery.js + terminal-outcome.test.js:288),那条
  //     写点不在本函数、不受影响。
  //   - lateCompletion:租约机器已整体退役(arm 侧 v136、读侧 2026-08-26 随
  //     lib/late-completion-lease.js 删除),此前的写分支是死码。
  // executionIncident 保留——不是死重量:operator 快照按 workItem.runtimeDiagnostics
  //   .executionIncident 汇总运行事故(operator-snapshot-summarizers.js:82 +
  //   operator-snapshot-runtime.js:310,workItem 的 runtimeDiagnostics 直接来自正本
  //   contract.runtimeDiagnostics,见 tracking-work-item.js:45),砍了 operator 事故面失真。
  if (executionIncident) {
    runtimeDiagnostics.executionIncident = executionIncident;
  }

  if (duplicateTerminalContract) {
    logger.info(
      `[watchdog] contract ${trackingState.contract.id} already ${effectiveContractData.status}, `
      + "skipping duplicate delivery",
    );
    markDuplicateTerminalTrackingState(
      trackingState,
      effectiveContractData.status,
      effectiveContractData.terminalOutcome || trackingState.contract?.terminalOutcome || null,
    );
    // 账物分离 batch2:duplicateTerminal 是零读者取证子字段(全库无人读正本这份),
    // 不再写正本;去重跳投的事实已由上面的 markDuplicateTerminalTrackingState + logger 承载。
  } else {
    const systemActionResults = normalizeSystemActionResults(
      context.systemActionResults ?? systemActionResult,
    );
    const primarySystemActionResult = selectPrimarySystemActionResult(systemActionResults);
    const deferredResults = systemActionResults.filter((result) => isDeferredSystemActionAccepted(result));
    const deferredSystemAction = deferredResults.length > 0;
    const deferredFollowUp = deferredSystemAction
      ? buildDeferredSystemActionFollowUp(primarySystemActionResult)
      : null;
    if (deferredFollowUp && deferredResults.length > 1) {
      deferredFollowUp.additionalDeferredCount = deferredResults.length - 1;
    }
    const systemActionFailureOutcome = deferredSystemAction
      ? null
      : deriveSystemActionTerminalOutcome(primarySystemActionResult, effectiveExecutionObservation);
    const graphTerminalOutcome = deferredSystemAction
      ? null
      : resolveGraphTerminalOutcome(context.graphRouteResult);
    // 终态优先级（短路顺序与原嵌套三元完全一致）：deferred > systemAction失败 > graph终态 > 兜底解析。
    // await 仅在前三者全 falsy 时求值，异步边界不变。
    let resolvedOutcome;
    if (deferredSystemAction) {
      resolvedOutcome = {
        terminalOutcome: {
          status: CONTRACT_STATUS.COMPLETED,
          reason: `deferred via ${primarySystemActionResult.actionType}`,
          source: "system_action",
        },
        terminalStatus: CONTRACT_STATUS.COMPLETED,
      };
    } else if (systemActionFailureOutcome) {
      resolvedOutcome = systemActionFailureOutcome;
    } else if (graphTerminalOutcome) {
      resolvedOutcome = graphTerminalOutcome;
    } else {
      resolvedOutcome = await resolveTerminalOutcome({
        trackingState,
        contractData: effectiveContractForOutcome,
        executionObservation: effectiveExecutionObservation,
        logger,
      });
    }
    const terminalOutcome = applyExecutionIncidentToTerminalOutcome(
      resolvedOutcome.terminalOutcome,
      executionIncident,
    );
    const terminalStatus = terminalOutcome?.status || resolvedOutcome.terminalStatus;
    const outputIoObservation = await buildOutputIoObservation({
      executionObservation: effectiveExecutionObservation,
      terminalOutcome,
    });
    if (outputIoObservation) {
      trackingState.ioObservation = mergeIoObservation(
        trackingState.ioObservation,
        outputIoObservation,
      );
    }
    const terminalExtraFields = {
      ...buildSystemActionContractFields(systemActionResults, { deferredFollowUp }),
      executionObservation: effectiveExecutionObservation || null,
      runtimeDiagnostics: mergeRuntimeDiagnostics(
        effectiveContractForOutcome?.runtimeDiagnostics || trackingState?.contract?.runtimeDiagnostics,
        trackingState.ioObservation ? { ioObservation: trackingState.ioObservation } : null,
      ),
    };

    const commitResult = await commitSemanticTerminalState({
      trackingState,
      terminalStatus,
      terminalOutcome,
      logger,
      extraFields: terminalExtraFields,
    });
    if (!commitResult.committed) {
      logger.error(`[agent-end] contract status persist failed for ${agentId}: ${commitResult.reason}`);
    } else {
      // 事件接线(批② §八):commit 后 = closed 时刻;GAP-02 run 关账判定在接线面内
      // (deriveRunOpenContracts 空 → run_closed + recorder 必编投影)。fire-and-forget。
      // tracker 副本可能未携谱系(绑定早于批②/手工投影);正本必有家(工厂兜底),
      // 缺位时按 id 回读正本谱系 —— 是解析不是 fabricate,closed 是 GAP-02 的判定输入,
      // 漏记会让 run 永不关账。
      void (async () => {
        let wireContract = trackingState.contract;
        if (wireContract?.id && !wireContract?.lineage) {
          const canonical = await readContractSnapshotById(wireContract.id).catch(() => null);
          if (canonical?.lineage) wireContract = { ...wireContract, lineage: canonical.lineage };
        }
        await wireClosed({
          contract: wireContract,
          terminalStatus,
          reason: terminalOutcome?.reason || null,
          logger,
        });
      })().catch((error) => {
        logger?.warn?.(`[agent-end] closed event wiring skipped: ${error?.message || error}`);
      });
    }

    // 投递出栈(备忘录141 §八):两段投递副作用(回投链+终态投递)不再在收口
    // 同步段执行——收口只落自包含票据 + poke 泵(fire-and-forget)。压制判定里
    // commit 时已知的部分(deferredSystemAction/deferredBy)投影进票据 suppress,
    // 链上压制由泵现场判定;现场投递诊断由泵事后并回正本,此处只记 deliveryTicketId。
    const deliveryContractId = trackingState.contract?.id || effectiveContractData?.id || null;
    if (deliveryContractId) {
      // 合约快照入票(审查①):受托会话的 DIRECT 信封合约不在共享目录,泵按 id
      // 重读必失败——票据快照是它们唯一的事实载体;path 一并携带供诊断写回定址。
      let contractSnapshot = null;
      try {
        contractSnapshot = JSON.parse(JSON.stringify({
          ...(effectiveContractData || trackingState.contract || {}),
          ...(trackingState.contract?.path ? { path: trackingState.contract.path } : {}),
        }));
      } catch { /* 不可序列化 → 泵回退共享正本重读 */ }
      const ticketPayload = {
        contractId: deliveryContractId,
        agentId,
        sessionKey: context.sessionKey || null,
        terminalStatus,
        terminalOutcome,
        executionObservation: effectiveExecutionObservation || null,
        contractSnapshot,
        suppress: {
          deferred: deferredSystemAction,
          deferredBy: deferredSystemAction ? (primarySystemActionResult.actionType || null) : null,
        },
        trackerProjection: {
          agentId: trackingState.agentId || agentId || null,
          startMs: trackingState.startMs,
          toolCallTotal: trackingState.toolCallTotal,
          ioObservation: trackingState.ioObservation || null,
        },
      };
      try {
        const deliveryTicket = await writeDeliveryTicket(ticketPayload);
        runtimeDiagnostics.deliveryTicketId = deliveryTicket.id;
        context._deliveryTicketPokePending = true;
        // 事件接线(批② §八):票据落盘 = ticket_written 时刻。fire-and-forget。
        void wireTicketWritten({
          contract: trackingState.contract || effectiveContractData,
          ticketId: deliveryTicket.id,
          logger,
        });
      } catch (error) {
        // 写票失败 = 盘上无票,扫描/背压无从恢复(审查②)——响警报并同步降级
        // 执行(等价旧收口行为),投递不静默丢失。
        logger.error(`[watchdog] delivery ticket write failed for ${agentId}: ${error.message} — falling back to inline delivery`);
        broadcast("alert", {
          type: EVENT_TYPE.DELIVERY_TICKET_WRITE_FAILED,
          agentId,
          contractId: deliveryContractId,
          error: error?.message || String(error),
          ts: Date.now(),
        });
        try {
          await executeDeliveryTicketPayload({ id: `dlv-${deliveryContractId}`, ...ticketPayload }, {
            api: context.api,
            logger,
          });
        } catch (inlineError) {
          logger.error(`[watchdog] inline delivery fallback failed for ${agentId}: ${inlineError.message}`);
        }
      }
    }
  }

  // （Path C HarnessRun 记录器已随 harness 全退役摘除，v226 / 2026-08-23，备忘录149 batch2）

  if (Object.keys(runtimeDiagnostics).length > 0) {
    await mergeTrackingContractFields({
      trackingState,
      extraFields: {
        runtimeDiagnostics: mergeRuntimeDiagnostics(
          trackingState.contract?.runtimeDiagnostics,
          runtimeDiagnostics,
        ),
      },
      logger,
    });
  }

  if (trackingState?.contract?.automationContext) {
    try {
      const { handleAutomationContractTerminal } = await import("../../automation/automation-executor.js");
      await handleAutomationContractTerminal(trackingState.contract, { logger });
    } catch (error) {
      logger.warn(`[watchdog] automation contract terminal hook failed: ${error.message}`);
    }
  }

  // 泵 poke 放在收口全部合约写(commit/诊断合并/automation 钩子)之后——泵的
  // 诊断写回以最新正本为基底,双写方竞态窗口收缩到零同进程赛点(审查⑤)。
  if (context._deliveryTicketPokePending) {
    try {
      pokeDeliveryPump({ api: context.api, logger });
    } catch (error) {
      logger.warn(`[watchdog] delivery pump poke failed for ${context.agentId}: ${error.message}`);
    }
  }
}
