// lib/operator-snapshot-summarizers.js — Summarize functions for operator snapshot entities

import { compactText } from "../core/normalize.js";
import {
  summarizeGraphRouteProgression,
  summarizeRuntimeIncident,
} from "./operator-snapshot-runtime.js";

function summarizeOperatorContext(operatorContext) {
  return {
    originDraftId: operatorContext?.originDraftId || null,
    originExecutionId: operatorContext?.originExecutionId || null,
    originSurfaceId: operatorContext?.originSurfaceId || null,
  };
}

export function summarizeAgent(agent) {
  const tools = Array.isArray(agent?.capabilities?.tools) ? agent.capabilities.tools : [];
  const skills = Array.isArray(agent?.effectiveSkills) ? agent.effectiveSkills : [];
  const outboxCommitKinds = Array.isArray(agent?.capabilities?.outboxCommitKinds)
    ? agent.capabilities.outboxCommitKinds
    : [];
  return {
    id: agent?.id || "unknown",
    role: agent?.role || null,
    model: agent?.model || null,
    heartbeatEvery: agent?.effectiveHeartbeatEvery || agent?.heartbeatEvery || null,
    toolCount: tools.length,
    tools: tools.slice(0, 8),
    skills,
    routerHandlerId: agent?.capabilities?.routerHandlerId || null,
    outboxCommitKinds,
    constrained: Boolean(agent?.constraints && Object.keys(agent.constraints).length > 0),
  };
}

export function summarizeSurface(surface) {
  return {
    id: surface?.id || "unknown",
    family: surface?.family || null,
    stage: surface?.stage || null,
    risk: surface?.risk || null,
    confirmation: surface?.confirmation || null,
    operatorPhase: surface?.operatorPhase || null,
    operatorExecutable: surface?.operatorExecutable === true,
    path: surface?.path || null,
    executable: surface?.executable === true,
    summary: compactText(surface?.summary, 100),
  };
}

export function summarizeDraft(draft) {
  return {
    id: draft?.id || "unknown",
    surfaceId: draft?.surfaceId || null,
    title: draft?.title || null,
    status: draft?.status || "draft",
    lastVerificationStatus: draft?.lastVerificationStatus || null,
    lastExecutionStatus: draft?.lastExecutionStatus || null,
    updatedAt: Number.isFinite(draft?.updatedAt) ? draft.updatedAt : null,
  };
}

export function summarizeWorkItem(workItem) {
  const deliveryTargets = Array.isArray(workItem?.deliveryTargets) ? workItem.deliveryTargets : [];
  return {
    id: workItem?.id || "unknown",
    status: workItem?.status || null,
    workItemKind: workItem?.workItemKind || null,
    assignee: workItem?.assignee || null,
    task: compactText(workItem?.task, 140),
    taskType: workItem?.taskType || null,
    pct: Number.isFinite(workItem?.pct) ? workItem.pct : null,
    updatedAt: Number.isFinite(workItem?.updatedAt) ? workItem.updatedAt : null,
    source: workItem?.source || null,
    replyTargetAgent: workItem?.replyTargetAgent || null,
    deliveryTargetCount: deliveryTargets.length,
    deliveryChannels: [...new Set(deliveryTargets.map((entry) => entry?.channel).filter(Boolean))],
    systemActionDeliveryTicketStatus: workItem?.systemActionDeliveryTicketStatus || null,
    systemActionDeliveryTicketRef: workItem?.systemActionDeliveryTicketRef || null,
    graphRouteProgression: summarizeGraphRouteProgression(workItem?.runtimeDiagnostics?.graphRouteProgression, workItem),
    incident: summarizeRuntimeIncident(workItem?.runtimeDiagnostics?.executionIncident),
    ioObservation: workItem?.ioObservation || workItem?.runtimeDiagnostics?.ioObservation || null,
    operatorContext: summarizeOperatorContext(workItem?.operatorContext),
  };
}

export function summarizeSystemActionDeliveryTicket(ticket) {
  return {
    id: ticket?.id || "unknown",
    lane: ticket?.lane || null,
    status: ticket?.status || null,
    intentType: ticket?.intentType || null,
    sourceAgentId: ticket?.source?.agentId || null,
    sourceContractId: ticket?.source?.contractId || null,
    targetAgent: ticket?.route?.targetAgent || null,
    targetSessionKey: ticket?.route?.targetSessionKey || null,
    createdAt: Number.isFinite(ticket?.createdAt) ? ticket.createdAt : null,
    resolvedAt: Number.isFinite(ticket?.resolvedAt) ? ticket.resolvedAt : null,
    operatorContext: summarizeOperatorContext(ticket?.metadata),
  };
}

export function summarizeSchedule(schedule) {
  const deliveryTargets = Array.isArray(schedule?.deliveryTargets) ? schedule.deliveryTargets : [];
  return {
    id: schedule?.id || "unknown",
    enabled: schedule?.enabled === true,
    trigger: schedule?.trigger || null,
    targetAgent: schedule?.entry?.targetAgent || null,
    systemActionDeliveryAgent: schedule?.systemActionDelivery?.agentId || null,
    deliveryTargetCount: deliveryTargets.length,
    deliveryChannels: [...new Set(deliveryTargets.map((entry) => entry?.channel).filter(Boolean))],
  };
}

export function summarizeAutomation(automation) {
  // harness 塑形投影已随 harness 全退役删除（v226 / 2026-08-23，备忘录149 batch3）。
  return {
    id: automation?.id || "unknown",
    enabled: automation?.enabled === true,
    objectiveSummary: automation?.objective?.summary || null,
    objectiveDomain: automation?.adapters?.domain || automation?.objective?.domain || null,
    targetAgent: automation?.entry?.targetAgent || null,
    wakeType: automation?.wakePolicy?.type || null,
    wakeScheduleId: automation?.wakePolicy?.scheduleId || null,
    runtimeStatus: automation?.runtime?.status || null,
    currentRound: Number.isFinite(automation?.runtime?.currentRound) ? automation.runtime.currentRound : 0,
    bestScore: automation?.runtime?.bestScore ?? null,
    childAutomationCount: Array.isArray(automation?.runtime?.childAutomationIds)
      ? automation.runtime.childAutomationIds.length
      : 0,
  };
}

export function summarizeAgentJoin(agentJoin) {
  return {
    id: agentJoin?.id || "unknown",
    enabled: agentJoin?.enabled === true,
    status: agentJoin?.summary?.status || null,
    localAgentId: agentJoin?.binding?.localAgentId || null,
    platformRole: agentJoin?.binding?.platformRole || null,
    protocolType: agentJoin?.protocol?.type || null,
    adapterKind: agentJoin?.adapter?.kind || null,
    baseUrl: agentJoin?.protocol?.baseUrl || null,
  };
}
