import { normalizeManagementActivityTargetSummary } from "../admin/admin-change-set-management.js";
import { projectAutomationHarnessSummary } from "../automation/automation-harness-projection.js";

function normalizeAgentPolicies(agent) {
  const bindingPolicies = agent?.binding?.policies && typeof agent.binding.policies === "object"
    ? agent.binding.policies
    : {};
  return {
    gateway: bindingPolicies.gateway === true,
    protected: bindingPolicies.protected === true,
    ingressSource: typeof bindingPolicies.ingressSource === "string" && bindingPolicies.ingressSource
      ? bindingPolicies.ingressSource
      : null,
    specialized: bindingPolicies.specialized === true,
  };
}

function buildAgentPolicySummary(policies) {
  const labels = [];
  labels.push(policies.gateway === true
    ? `gateway:${policies.ingressSource || "default"}`
    : "office");
  if (policies.protected === true) labels.push("protected");
  if (policies.specialized === true) labels.push("specialized");
  return labels.join(" // ");
}

function normalizeAutomationSummary(automation) {
  const harnessSummary = projectAutomationHarnessSummary({
    harness: automation?.harness,
    runtime: automation?.runtime,
  });

  return {
    objectiveSummary: automation?.objective?.summary || null,
    objectiveDomain: automation?.adapters?.domain || automation?.objective?.domain || null,
    targetAgent: automation?.entry?.targetAgent || null,
    runtimeStatus: automation?.runtime?.status || null,
    currentRound: Number.isFinite(automation?.runtime?.currentRound) ? automation.runtime.currentRound : 0,
    bestScore: automation?.runtime?.bestScore ?? null,
    executionMode: harnessSummary.executionMode,
    assuranceLevel: harnessSummary.assuranceLevel || null,
    harnessEnabled: harnessSummary.harnessEnabled === true,
    harnessProfileId: harnessSummary.harnessProfileId || null,
    harnessProfileTrustLevel: harnessSummary.harnessProfileTrustLevel || null,
    harnessCoverage: harnessSummary.harnessCoverage,
    harnessCoverageCounts: harnessSummary.harnessCoverageCounts,
    activeHarnessGateVerdict: harnessSummary.activeHarnessGateVerdict,
    activeHarnessPendingModuleCount: harnessSummary.activeHarnessPendingModuleCount,
    activeHarnessFailedModuleCount: harnessSummary.activeHarnessFailedModuleCount,
    lastHarnessGateVerdict: harnessSummary.lastHarnessGateVerdict,
    lastHarnessFailedModuleCount: harnessSummary.lastHarnessFailedModuleCount,
    recentHarnessRunCount: harnessSummary.recentHarnessRunCount,
  };
}

function resolveAutomationHarnessGateVerdict(summary) {
  return summary.activeHarnessGateVerdict
    || summary.lastHarnessGateVerdict
    || "none";
}

function resolveAutomationHarnessFailureCount(summary) {
  return Math.max(
    Number(summary.activeHarnessFailedModuleCount) || 0,
    Number(summary.lastHarnessFailedModuleCount) || 0,
  );
}

export function buildAgentManagement(agentId, subject, activity = null) {
  const inspectSurfaces = Array.isArray(subject?.inspectSurfaces)
    ? subject.inspectSurfaces.filter((surface) => surface.subjectScope === "instance" || surface.subjectScope === "catalog")
    : [];
  const applySurfaces = Array.isArray(subject?.applySurfaces)
    ? subject.applySurfaces.filter((surface) => surface.subjectScope === "instance")
    : [];
  const verifySurfaces = Array.isArray(subject?.verifySurfaces)
    ? subject.verifySurfaces.filter((surface) => surface.subjectScope === "instance")
    : [];
  const manageableAspects = Array.isArray(subject?.managedAspects)
    ? subject.managedAspects.filter((item) => applySurfaces.some((surface) => surface.id === item.surfaceId))
    : [];

  return {
    subjectKind: "agent",
    subjectScope: "instance",
    selector: { key: "agentId", value: agentId },
    inspectSurfaceIds: inspectSurfaces.map((surface) => surface.id),
    applySurfaceIds: applySurfaces.map((surface) => surface.id),
    verifySurfaceIds: verifySurfaces.map((surface) => surface.id),
    manageableAspects: manageableAspects.map((item) => item.aspect),
    activity: normalizeManagementActivityTargetSummary(activity),
  };
}

export function buildAgentManagementTarget(agent, subject, activity = null) {
  const management = buildAgentManagement(agent.id, subject, activity);
  const policies = normalizeAgentPolicies(agent);
  const policySummary = buildAgentPolicySummary(policies);
  return {
    id: agent.id,
    label: agent.name || agent.id,
    meta: [
      agent.name && agent.name !== agent.id ? agent.id : null,
      agent.role || null,
      agent.model || null,
    ].filter(Boolean).join(" // "),
    detail: [
      agent.description || null,
      policySummary,
    ].filter(Boolean).join(" // ") || null,
    description: agent.description || null,
    policies,
    policySummary,
    selector: management.selector,
    composeAgentId: agent.id,
    inspectSurfaceIds: management.inspectSurfaceIds,
    applySurfaceIds: management.applySurfaceIds,
    verifySurfaceIds: management.verifySurfaceIds,
    manageableAspects: management.manageableAspects,
    activity: management.activity,
    snapshot: {
      id: agent.id,
      name: agent.name,
      role: agent.role,
      model: agent.model,
      configuredHeartbeatEvery: agent.configuredHeartbeatEvery,
      effectiveHeartbeatEvery: agent.effectiveHeartbeatEvery,
      constraints: agent.constraints,
      capabilities: agent.capabilities,
      configuredSkills: agent.configuredSkills,
      effectiveSkills: agent.effectiveSkills,
      gateway: agent.gateway === true,
      protected: agent.protected === true,
      ingressSource: agent.ingressSource || null,
      specialized: agent.specialized === true,
      policies,
      binding: agent.binding || null,
      management,
    },
  };
}

export function buildAutomationManagement(automationId, subject, activity = null) {
  const inspectSurfaces = Array.isArray(subject?.inspectSurfaces)
    ? subject.inspectSurfaces.filter((surface) => surface.subjectScope === "instance" || surface.subjectScope === "catalog")
    : [];
  const applySurfaces = Array.isArray(subject?.applySurfaces)
    ? subject.applySurfaces.filter((surface) => surface.subjectScope === "instance")
    : [];
  const verifySurfaces = Array.isArray(subject?.verifySurfaces)
    ? subject.verifySurfaces.filter((surface) => surface.subjectScope === "instance")
    : [];
  const manageableAspects = Array.isArray(subject?.managedAspects)
    ? subject.managedAspects.filter((item) => applySurfaces.some((surface) => surface.id === item.surfaceId))
    : [];

  return {
    subjectKind: "automation",
    subjectScope: "instance",
    selector: { key: "automationId", value: automationId },
    inspectSurfaceIds: inspectSurfaces.map((surface) => surface.id),
    applySurfaceIds: applySurfaces.map((surface) => surface.id),
    verifySurfaceIds: verifySurfaces.map((surface) => surface.id),
    manageableAspects: manageableAspects.map((item) => item.aspect),
    activity: normalizeManagementActivityTargetSummary(activity),
  };
}

export function buildAutomationManagementTarget(automation, subject, activity = null) {
  const summary = normalizeAutomationSummary(automation);
  const management = buildAutomationManagement(automation.id, subject, activity);
  const gateVerdict = resolveAutomationHarnessGateVerdict(summary);
  const failedModuleCount = resolveAutomationHarnessFailureCount(summary);
  const pendingModuleCount = Number(summary.activeHarnessPendingModuleCount) || 0;

  return {
    id: automation.id,
    label: summary.objectiveSummary || automation.id,
    meta: [
      summary.targetAgent || null,
      summary.runtimeStatus || "idle",
      summary.executionMode || "freeform",
    ].filter(Boolean).join(" // "),
    detail: [
      summary.objectiveDomain || null,
      summary.harnessProfileId ? `profile:${summary.harnessProfileId}` : null,
      gateVerdict !== "none" ? `gate:${gateVerdict}` : null,
      pendingModuleCount > 0 ? `pending:${pendingModuleCount}` : null,
      failedModuleCount > 0 ? `failed:${failedModuleCount}` : null,
    ].filter(Boolean).join(" // ") || null,
    description: summary.objectiveSummary || automation?.objective?.summary || null,
    selector: management.selector,
    inspectSurfaceIds: management.inspectSurfaceIds,
    applySurfaceIds: management.applySurfaceIds,
    verifySurfaceIds: management.verifySurfaceIds,
    manageableAspects: management.manageableAspects,
    activity: management.activity,
    snapshot: {
      ...automation,
      management,
    },
  };
}

export function buildAgentJoinManagement(joinId, subject, activity = null) {
  const inspectSurfaces = Array.isArray(subject?.inspectSurfaces)
    ? subject.inspectSurfaces.filter((surface) => surface.subjectScope === "instance" || surface.subjectScope === "catalog")
    : [];
  const applySurfaces = Array.isArray(subject?.applySurfaces)
    ? subject.applySurfaces.filter((surface) => surface.subjectScope === "instance")
    : [];
  const verifySurfaces = Array.isArray(subject?.verifySurfaces)
    ? subject.verifySurfaces.filter((surface) => surface.subjectScope === "instance")
    : [];
  const manageableAspects = Array.isArray(subject?.managedAspects)
    ? subject.managedAspects.filter((item) => applySurfaces.some((surface) => surface.id === item.surfaceId))
    : [];

  return {
    subjectKind: "agent_join",
    subjectScope: "instance",
    selector: { key: "joinId", value: joinId },
    inspectSurfaceIds: inspectSurfaces.map((surface) => surface.id),
    applySurfaceIds: applySurfaces.map((surface) => surface.id),
    verifySurfaceIds: verifySurfaces.map((surface) => surface.id),
    manageableAspects: manageableAspects.map((item) => item.aspect),
    activity: normalizeManagementActivityTargetSummary(activity),
  };
}

export function buildAgentJoinManagementTarget(agentJoin, subject, activity = null) {
  const management = buildAgentJoinManagement(agentJoin.id, subject, activity);
  return {
    id: agentJoin.id,
    label: agentJoin?.identity?.name || agentJoin?.binding?.localAgentId || agentJoin.id,
    meta: [
      agentJoin?.binding?.localAgentId || null,
      agentJoin?.binding?.platformRole || null,
      agentJoin?.protocol?.type || null,
    ].filter(Boolean).join(" // "),
    detail: [
      agentJoin?.adapter?.kind || null,
      agentJoin?.summary?.status || null,
      agentJoin?.protocol?.baseUrl || null,
    ].filter(Boolean).join(" // ") || null,
    description: agentJoin?.identity?.description || null,
    selector: management.selector,
    inspectSurfaceIds: management.inspectSurfaceIds,
    applySurfaceIds: management.applySurfaceIds,
    verifySurfaceIds: management.verifySurfaceIds,
    manageableAspects: management.manageableAspects,
    activity: management.activity,
    snapshot: {
      ...agentJoin,
      management,
    },
  };
}

export function buildModelManagementTarget(model) {
  return {
    id: model.id,
    label: model.name || model.id,
    meta: [model.provider, model.contextWindow ? `${model.contextWindow}` : null]
      .filter(Boolean)
      .join(" // "),
    detail: model.family || model.api || null,
    selector: { key: "id", value: model.id },
    snapshot: model,
  };
}

export function buildAgentDefaultsManagementTarget(agentDefaults) {
  return {
    id: "agent-defaults",
    label: "AGENT DEFAULTS",
    meta: [
      agentDefaults?.effectiveModelPrimary || null,
      agentDefaults?.effectiveHeartbeatEvery || null,
    ].filter(Boolean).join(" // "),
    detail: `${Array.isArray(agentDefaults?.configuredDefaultSkills) ? agentDefaults.configuredDefaultSkills.length : 0} configured default skills`,
    selector: null,
    snapshot: agentDefaults,
  };
}
