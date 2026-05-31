import { CONTRACT_STATUS } from "../core/runtime-status.js";
import { inspectCliRuntimeState } from "../cli-system/cli-runtime-inspector.js";

export function summarizeRuntimeIncident(incident) {
  if (!incident || typeof incident !== "object") return null;
  return {
    contractId: incident.contractId || null,
    rootFault: incident.rootFault || null,
    firstFaultCode: incident.firstFaultCode || null,
    amplifiers: Array.isArray(incident.amplifiers) ? incident.amplifiers : [],
    status: incident.status || null,
    terminationReason: incident.terminationReason || null,
    updatedAt: Number.isFinite(incident.updatedAt) ? incident.updatedAt : null,
  };
}

function mapTrackingSessions(limit, trackingSnapshot = {}) {
  const sessions = Object.entries(trackingSnapshot || {})
    .map(([sessionKey, entry]) => ({
      sessionKey,
      agentId: entry?.agentId || null,
      plane: entry?.plane || null,
      mainViewVisible: entry?.mainViewVisible !== false,
      formalTimelineVisible: entry?.formalTimelineVisible !== false,
      autoWakeEligible: entry?.autoWakeEligible !== false,
      status: entry?.status || null,
      pct: Number.isFinite(entry?.pct) ? entry.pct : null,
      elapsedMs: Number.isFinite(entry?.elapsedMs) ? entry.elapsedMs : 0,
      toolCallCount: Number.isFinite(entry?.toolCallCount) ? entry.toolCallCount : 0,
      lastLabel: entry?.lastLabel || null,
      hasContract: entry?.hasContract === true,
      workItemId: entry?.workItemId || null,
      workItemKind: entry?.workItemKind || null,
      task: entry?.task || null,
      taskType: entry?.taskType || null,
      protocolEnvelope: entry?.protocolEnvelope || null,
      cursor: entry?.cursor || null,
    }))
    .sort((left, right) => (right.elapsedMs || 0) - (left.elapsedMs || 0));

  return {
    total: sessions.length,
    running: sessions.filter((entry) => entry.status === CONTRACT_STATUS.RUNNING).length,
    runningWithoutContract: sessions.filter((entry) => (
      entry.status === CONTRACT_STATUS.RUNNING
      && entry.hasContract !== true
      && isRuntimeQueueTrackingSession(entry)
    )).length,
    sessions: sessions.slice(0, limit),
  };
}

function isRuntimeQueueTrackingSession(entry) {
  return (
    entry?.plane === "runtime"
    && entry?.formalTimelineVisible !== false
  );
}

function mapDispatchTargets(runtimeSnapshot = null) {
  const snapshot = runtimeSnapshot || {};
  const targets = Object.entries(snapshot.targets || {})
    .map(([agentId, state]) => ({
      agentId,
      busy: state?.busy === true,
      healthy: state?.healthy !== false,
      dispatching: state?.dispatching === true,
      currentContract: state?.currentContract || null,
      queueDepth: Array.isArray(state?.queue) ? state.queue.length : 0,
      queue: Array.isArray(state?.queue) ? [...state.queue] : [],
      tools: Array.isArray(state?.tools) ? state.tools : [],
    }))
    .sort((left, right) => left.agentId.localeCompare(right.agentId));

  return {
    total: targets.length,
    busy: targets.filter((entry) => entry.busy).length,
    idle: targets.filter((entry) => !entry.busy).length,
    unhealthy: targets.filter((entry) => entry.healthy === false).length,
    dispatching: targets.filter((entry) => entry.dispatching).length,
    queued: targets.reduce((sum, entry) => sum + entry.queueDepth, 0),
    targets,
  };
}

function buildRuntimeQueueDiagnostics({
  tracking,
  targets,
} = {}) {
  const issues = [];
  const runningWithoutContract = Array.isArray(tracking?.sessions)
    ? tracking.sessions.filter((entry) => (
        entry.status === CONTRACT_STATUS.RUNNING
        && entry.hasContract !== true
        && isRuntimeQueueTrackingSession(entry)
      ))
    : [];
  for (const session of runningWithoutContract) {
    issues.push({
      severity: "error",
      code: "running_tracking_without_contract",
      agentId: session.agentId || null,
      sessionKey: session.sessionKey || null,
      elapsedMs: session.elapsedMs || 0,
      summary: "运行中的 tracking session 没有绑定 contract，可能阻断 queue claim 或产生幽灵工具调用。",
    });
  }

  const targetEntries = Array.isArray(targets?.targets) ? targets.targets : [];
  for (const target of targetEntries) {
    const firstQueuedContract = Array.isArray(target.queue) ? target.queue[0] : null;
    const nextContractId = typeof firstQueuedContract === "string"
      ? firstQueuedContract
      : firstQueuedContract?.contractId || null;
    if (
      target.queueDepth > 0
      && target.busy !== true
      && target.dispatching !== true
      && !target.currentContract
    ) {
      issues.push({
        severity: "warning",
        code: "idle_target_with_pending_queue",
        agentId: target.agentId,
        queueDepth: target.queueDepth,
        nextContractId,
        summary: "dispatch target 空闲但仍有 pending queue，可能需要 drain 或存在 claim/requeue 循环。",
      });
    }
  }

  return {
    issueCount: issues.length,
    hasSplitBrain: issues.some((issue) => issue.code === "running_tracking_without_contract"),
    issues,
  };
}

export function summarizeGraphRouteProgression(progression, contract = null) {
  if (!progression || typeof progression !== "object") return null;

  const reason = progression?.reason || null;
  let outcome = "idle";
  if (reason === "system_action_owned") outcome = "agent_owned";
  else if (progression?.error) outcome = "error";
  else if (progression?.attempted === true && progression?.action) outcome = progression.action;
  else if (progression?.skipped === true) outcome = "skipped";
  else if (progression?.attempted === true) outcome = "attempted";

  return {
    contractId: contract?.id || null,
    contractStatus: contract?.status || null,
    attempted: progression?.attempted === true,
    skipped: progression?.skipped === true,
    outcome,
    reason,
    action: progression?.action || null,
    from: progression?.from || progression?.stage || null,
    to: progression?.to || null,
    targetAgent: progression?.targetAgent || null,
    pipelineId: progression?.pipelineId || null,
    loopId: progression?.loopId || null,
    loopSessionId: progression?.loopSessionId || null,
    round: Number.isFinite(progression?.round) ? progression.round : null,
    actionType: progression?.actionType || null,
    runtimeStatus: progression?.status || null,
    error: progression?.error || null,
    ts: Number.isFinite(progression?.ts) ? progression.ts : null,
    updatedAt: Number.isFinite(contract?.updatedAt) ? contract.updatedAt : null,
    createdAt: Number.isFinite(contract?.createdAt) ? contract.createdAt : null,
  };
}

export function listRecentGraphRouteProgressions(workItems, {
  activeLoopSession = null,
  limit = 6,
} = {}) {
  const items = (Array.isArray(workItems) ? workItems : [])
    .map((workItem) => summarizeGraphRouteProgression(workItem?.runtimeDiagnostics?.graphRouteProgression, workItem))
    .filter(Boolean)
    .sort((left, right) => (
      (right?.ts || right?.updatedAt || right?.createdAt || 0)
      - (left?.ts || left?.updatedAt || left?.createdAt || 0)
    ));

  if (!activeLoopSession) {
    return items.slice(0, limit);
  }

  const activeItems = items.filter((item) => (
    (item?.loopSessionId && item.loopSessionId === activeLoopSession.id)
    || (item?.pipelineId && item.pipelineId === activeLoopSession.pipelineId)
  ));

  return (activeItems.length > 0 ? activeItems : items).slice(0, limit);
}

export function buildReviewerResultsSnapshot(automations) {
  const entries = (Array.isArray(automations?.automations) ? automations.automations : [])
    .filter((a) => a?.runtime?.lastReviewerResult)
    .map((a) => ({
      automationId: a.id || a.runtime?.automationId || null,
      round: a.runtime?.currentRound || null,
      ...a.runtime.lastReviewerResult,
    }));
  return {
    total: entries.length,
    results: entries.slice(0, 10),
  };
}

export function buildAutomationDecisionsSnapshot(automations) {
  const entries = (Array.isArray(automations?.automations) ? automations.automations : [])
    .filter((a) => a?.runtime?.lastAutomationDecision)
    .map((a) => ({
      automationId: a.id || a.runtime?.automationId || null,
      ...a.runtime.lastAutomationDecision,
    }));
  return {
    total: entries.length,
    decisions: entries.slice(0, 10),
  };
}

export function buildAttentionItems({
  draftCounts,
  workItemCounts,
  systemActionDeliveryCounts,
  runtimeSummary,
  recentRuntimeIncidents = [],
  activeTestRun,
  automationCounts,
}) {
  const items = [];

  if ((workItemCounts[CONTRACT_STATUS.FAILED] || 0) > 0) {
    items.push({
      severity: "error",
      area: "work_items",
      count: workItemCounts[CONTRACT_STATUS.FAILED],
      summary: "存在失败 work item，需要看失败原因和 system_action delivery 状态。",
      path: "/watchdog/work-items",
    });
  }
  if ((workItemCounts[CONTRACT_STATUS.AWAITING_INPUT] || 0) > 0) {
    items.push({
      severity: "warning",
      area: "work_items",
      count: workItemCounts[CONTRACT_STATUS.AWAITING_INPUT],
      summary: "存在等待补充输入的 work item。",
      path: "/watchdog/work-items",
    });
  }
  if ((draftCounts.failed || 0) > 0 || (draftCounts.verification_failed || 0) > 0) {
    items.push({
      severity: "warning",
      area: "change_sets",
      count: (draftCounts.failed || 0) + (draftCounts.verification_failed || 0),
      summary: "存在执行失败或验证失败的 change-set 草稿。",
      path: "/watchdog/admin-change-sets",
    });
  }
  if ((systemActionDeliveryCounts.active || 0) > 0) {
    items.push({
      severity: "warning",
      area: "system_action_deliveries",
      count: systemActionDeliveryCounts.active,
      summary: "存在未完成的 system_action delivery ticket。",
      path: "/watchdog/system-action-delivery-tickets",
    });
  }
  if ((runtimeSummary.targets.unhealthy || 0) > 0) {
    items.push({
      severity: "warning",
      area: "runtime",
      count: runtimeSummary.targets.unhealthy,
      summary: "dispatch targets 中有 unhealthy agent。",
      path: "/watchdog/runtime",
    });
  }
  if ((runtimeSummary.queueDiagnostics?.issueCount || 0) > 0) {
    items.push({
      severity: runtimeSummary.queueDiagnostics.hasSplitBrain ? "error" : "warning",
      area: "runtime_queue",
      count: runtimeSummary.queueDiagnostics.issueCount,
      summary: "dispatch queue / tracking 出现不一致，需要检查 claim、staging 与 target 状态。",
      path: "/watchdog/runtime",
    });
  }
  if ((recentRuntimeIncidents.length || 0) > 0) {
    items.push({
      severity: "error",
      area: "runtime",
      count: recentRuntimeIncidents.length,
      summary: "存在 incident-backed runtime fault，需要优先查看 rootFault / firstFaultCode。",
      path: "/watchdog/runtime",
    });
  }
  if ((runtimeSummary.queueDepth || 0) > 0) {
    items.push({
      severity: "info",
      area: "runtime",
      count: runtimeSummary.queueDepth,
      summary: "任务队列中仍有待派发 contract。",
      path: "/watchdog/runtime",
    });
  }
  if (activeTestRun) {
    items.push({
      severity: "info",
      area: "tests",
      count: 1,
      summary: "存在正在运行的测试套件。",
      path: "/watchdog/test-runs",
    });
  }
  if ((automationCounts?.failingHarnessAutomations || 0) > 0) {
    items.push({
      severity: "error",
      area: "automations",
      count: automationCounts.failingHarnessAutomations,
      summary: `存在 ${automationCounts.failedHarnessModules || 0} 个 harness 失败模块，需要检查 guard/gate 漂移。`,
      path: "/watchdog/automations",
    });
  }
  if ((automationCounts?.pendingHarnessAutomations || 0) > 0) {
    items.push({
      severity: "info",
      area: "automations",
      count: automationCounts.pendingHarnessAutomations,
      summary: `存在 ${automationCounts.pendingHarnessModules || 0} 个待收敛 harness 模块，仍在等待本轮执行证据。`,
      path: "/watchdog/automations",
    });
  }

  return items;
}

export function resolveSnapshotState(attentionItems, runtimeSummary, activeTestRun) {
  if (attentionItems.some((item) => item.severity === "error")) return "attention";
  if (attentionItems.some((item) => item.severity === "warning")) return "watch";
  if (activeTestRun || runtimeSummary.queueDepth > 0 || runtimeSummary.tracking.total > 0) return "busy";
  return "idle";
}

export function buildRuntimeSummary(limit) {
  const runtimeState = inspectCliRuntimeState();
  const runtimeSnapshot = runtimeState.dispatchRuntime || {};
  const tracking = mapTrackingSessions(limit, runtimeState.trackingSessions);
  const targets = mapDispatchTargets(runtimeSnapshot);

  return {
    queueDepth: Array.isArray(runtimeSnapshot.queue) ? runtimeSnapshot.queue.length : 0,
    tracking,
    targets,
    queueDiagnostics: buildRuntimeQueueDiagnostics({
      tracking,
      targets,
    }),
  };
}

export function listRecentRuntimeIncidents(workItems, {
  limit = 6,
} = {}) {
  return (Array.isArray(workItems) ? workItems : [])
    .map((workItem) => summarizeRuntimeIncident(workItem?.runtimeDiagnostics?.executionIncident))
    .filter(Boolean)
    .sort((left, right) => (right?.updatedAt || 0) - (left?.updatedAt || 0))
    .slice(0, limit);
}
