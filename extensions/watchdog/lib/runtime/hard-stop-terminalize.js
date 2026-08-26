import { CONTRACT_STATUS } from "../core/runtime-status.js";
import { commitSemanticTerminalState } from "../routing/terminal-commit.js";
import { wireClosed } from "../archive/run-event-wiring.js";
import { finalizeAgentSession } from "../lifecycle/runtime-lifecycle.js";
import { mergeRuntimeDiagnostics } from "../lifecycle/agent-end/contract-refresh.js";
import { getSessionHardStopReason, HARD_STOP_REASON } from "../runtime/execution-hard-stop-registry.js";
import { resolveSessionEpochKey } from "../runtime/session-epoch-key.js";
import { getExecutionIncident } from "./execution-incident-store.js";
import { normalizeTerminalOutcome, resolveTerminalOutcome } from "../contract/terminal-outcome.js";
import { getSessionProgress } from "../evidence/session-progress-projection.js";
import { resolveRouteAfterAgentEndTarget } from "../routing/dispatch/dispatch-graph-policy.js";

const terminalizingSessions = new Set();

// 硬停终态的 source 名。这是**执行硬停闸**(重复调用/工具预算/输出预算/人工终止)的
// 署名,与图回路无关——旧名 "loop_runtime" 是回路运行时时代的遗留错名,2026-08-19 改正。
// 该字段无枚举校验(唯一消费者是 delivery-terminal-runtime.js 的 SSE alert 透传),
// 所以只能靠这一个导出常量当单一真值,生产端与断言端都引它。
export const HARD_STOP_TERMINAL_SOURCE = "execution_hard_stop";

function resolveHardStopReason(epochKey) {
  return getSessionHardStopReason(epochKey) || HARD_STOP_REASON.UNSPECIFIED;
}

// 硬停文案的唯一分表。agent_end 侧的 graph-route 硬停闸也引这里——
// 同一个 reason 由两条收口路径给出两句不同结论,是过去平行拷贝踩过的坑。
export function buildHardStopSummary(reason) {
  const summaryByReason = {
    [HARD_STOP_REASON.REPEAT_THRESHOLD]: "session terminated due to repeated identical tool calls before final output was committed",
    [HARD_STOP_REASON.MAX_TOOL_CALLS]: "session terminated because executionPolicy.maxToolCalls budget was exhausted",
    [HARD_STOP_REASON.OUTPUT_BUDGET_EXHAUSTED]: "session terminated because the cumulative tool-output byte budget was exhausted",
    [HARD_STOP_REASON.MANUAL]: "session terminated by explicit operator intervention",
  };
  return summaryByReason[reason] || `session hard-stopped (${reason}) before final output was committed`;
}

function mergeExecutionIncidentIntoOutcome(terminalOutcome, executionIncident) {
  if (!executionIncident?.rootFault) {
    return terminalOutcome;
  }
  return normalizeTerminalOutcome({
    ...terminalOutcome,
    reason: executionIncident.terminationReason
      || executionIncident.firstFaultCode
      || terminalOutcome.reason,
    clarification: [
      terminalOutcome.clarification,
      `runtime incident: ${[
        executionIncident.rootFault,
        executionIncident.firstFaultCode || null,
      ].filter(Boolean).join(" / ")}`,
    ].filter(Boolean).join(" | ") || null,
  }, {
    terminalStatus: CONTRACT_STATUS.FAILED,
  });
}

async function shouldDeferHardStopTerminalization({
  agentId,
  sessionKey,
} = {}) {
  const traceVerdict = getSessionProgress(sessionKey);
  const route = await resolveRouteAfterAgentEndTarget(agentId, { status: "completed" });
  if (route?.routable && route?.target && traceVerdict?.outputCommitted === true) {
    return {
      defer: true,
      reason: "graph_route_after_committed_output",
    };
  }

  return {
    defer: false,
    reason: null,
  };
}

export async function terminalizeHardStoppedRuntimeSession({
  agentId,
  sessionKey,
  trackingState,
  api,
  logger,
} = {}) {
  if (!trackingState?.contract?.id || !sessionKey || !agentId) {
    return { terminalized: false, reason: "missing_tracking_contract" };
  }
  if (trackingState.status === CONTRACT_STATUS.FAILED || trackingState.contract.status === CONTRACT_STATUS.FAILED) {
    return { terminalized: false, reason: "already_failed" };
  }
  if (trackingState.status === CONTRACT_STATUS.COMPLETED || trackingState.contract.status === CONTRACT_STATUS.COMPLETED) {
    return { terminalized: false, reason: "already_completed" };
  }

  const epochKey = resolveSessionEpochKey(trackingState) || sessionKey;
  const lockKey = `${sessionKey}:${trackingState.contract.id}`;
  if (terminalizingSessions.has(lockKey)) {
    return { terminalized: false, reason: "terminalize_in_progress" };
  }
  terminalizingSessions.add(lockKey);
  try {
    const deferCheck = await shouldDeferHardStopTerminalization({
      agentId,
      sessionKey,
    });
    if (deferCheck.defer) {
      return { terminalized: false, reason: deferCheck.reason };
    }

    const hardStopReason = resolveHardStopReason(epochKey);
    const executionIncident = getExecutionIncident({
      contractId: trackingState.contract.id,
      epochKey,
      sessionKey,
    });
    // 收口只有一条路:与 agent_end 相同的事实收口,带 halted 事实。
    // 声明了 failed → 转述;声明了 completed/期望齐 → 采信;中断且没交代 → 失败。
    const resolved = await resolveTerminalOutcome({
      trackingState,
      contractData: trackingState.contract,
      executionObservation: trackingState.contract.executionObservation || null,
      logger,
      halted: true,
    });
    const baseOutcome = normalizeTerminalOutcome({
      ...resolved.terminalOutcome,
      source: HARD_STOP_TERMINAL_SOURCE,
      reason: resolved.terminalOutcome.reason || hardStopReason,
      summary: resolved.terminalOutcome.summary
        || buildHardStopSummary(hardStopReason),
    }, { terminalStatus: resolved.terminalStatus });
    const terminalOutcome = mergeExecutionIncidentIntoOutcome(baseOutcome, executionIncident);
    const terminalStatus = terminalOutcome?.status || CONTRACT_STATUS.FAILED;
    const runtimeDiagnostics = mergeRuntimeDiagnostics(
      trackingState.contract.runtimeDiagnostics,
      {
        executionHardStop: {
          terminalized: true,
          reason: hardStopReason,
          epochKey,
          ts: Date.now(),
        },
        ...(executionIncident ? { executionIncident } : {}),
      },
    );
    const commitResult = await commitSemanticTerminalState({
      trackingState,
      terminalStatus,
      terminalOutcome,
      logger,
      extraFields: {
        runtimeDiagnostics,
      },
    });
    if (!commitResult.committed) {
      return { terminalized: false, reason: commitResult.reason || "commit_failed" };
    }
    // 审查③:硬停终态同样要在事件账落 closed(否则该约在真值里永远 open)。
    void wireClosed({
      contract: trackingState?.contract,
      terminalStatus,
      reason: hardStopReason,
      logger,
    });

    await finalizeAgentSession({
      agentId,
      sessionKey,
      trackingState,
      api,
      logger,
    });
    return {
      terminalized: true,
      reason: hardStopReason,
      terminalOutcome,
    };
  } finally {
    terminalizingSessions.delete(lockKey);
  }
}
