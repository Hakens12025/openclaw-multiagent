import { CONTRACT_STATUS } from "../core/runtime-status.js";
import { buildDispatchRuntimeSnapshot } from "../routing/dispatch-runtime-state.js";
import { snapshotTrackingSessions } from "../store/tracker-store.js";

function mapTrackingSessions(limit) {
  const sessions = Object.entries(snapshotTrackingSessions())
    .map(([sessionKey, entry]) => ({
      sessionKey,
      agentId: entry?.agentId || null,
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
    sessions: sessions.slice(0, limit),
  };
}

function mapDispatchTargets(runtimeSnapshot = null) {
  const snapshot = runtimeSnapshot || buildDispatchRuntimeSnapshot();
  const targets = Object.entries(snapshot.targets || {})
    .map(([agentId, state]) => ({
      agentId,
      busy: state?.busy === true,
      healthy: state?.healthy !== false,
      dispatching: state?.dispatching === true,
      currentContract: state?.currentContract || null,
    }))
    .sort((left, right) => left.agentId.localeCompare(right.agentId));

  return {
    total: targets.length,
    busy: targets.filter((entry) => entry.busy).length,
    idle: targets.filter((entry) => !entry.busy).length,
    unhealthy: targets.filter((entry) => entry.healthy === false).length,
    dispatching: targets.filter((entry) => entry.dispatching).length,
    targets,
  };
}

export function summarizePipelineProgression(progression, contract = null) {
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

export function listRecentPipelineProgressions(workItems, {
  activeLoopSession = null,
  limit = 6,
} = {}) {
  const items = (Array.isArray(workItems) ? workItems : [])
    .map((workItem) => summarizePipelineProgression(workItem?.runtimeDiagnostics?.pipelineProgression, workItem))
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
  const tracking = mapTrackingSessions(limit);
  const runtimeSnapshot = buildDispatchRuntimeSnapshot();
  const targets = mapDispatchTargets(runtimeSnapshot);

  return {
    queueDepth: Array.isArray(runtimeSnapshot.queue) ? runtimeSnapshot.queue.length : 0,
    tracking,
    targets,
  };
}
