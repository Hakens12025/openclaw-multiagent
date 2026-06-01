// lib/operator-snapshot.js — Core data loading & operator snapshot assembly

import { listAgentRegistry } from "../capability/capability-registry.js";
import { inspectCliSystemSurface, summarizeCliSystemSurfaces } from "../cli-system/cli-surface-registry.js";
import { normalizeString } from "../core/normalize.js";
import { operatorAutoPropose } from "./operator-auto-propose.js";
import {
  buildAttentionItems,
  buildAutomationDecisionsSnapshot,
  buildReviewerResultsSnapshot,
  buildRuntimeSummary,
  listRecentRuntimeIncidents,
  listRecentGraphRouteProgressions,
  resolveSnapshotState,
} from "./operator-snapshot-runtime.js";
import {
  loadRecentTestReports,
  summarizeHarnessRun,
  summarizeTestRun,
} from "./operator-snapshot-tests.js";
import {
  summarizeAgent,
  summarizeAgentJoin,
  summarizeAutomation,
  summarizeWorkItem,
  summarizeLoop,
  summarizeLoopSession,
  summarizeSystemActionDeliveryTicket,
  summarizeSchedule,
  summarizeSurface,
} from "./operator-snapshot-summarizers.js";
import {
  buildDraftRelations,
  buildDraftScopedAttention,
  buildWorkQueue,
  summarizeDraftWithRelations,
} from "./operator-snapshot-draft-relations.js";
import { CONTRACT_STATUS } from "../core/runtime-status.js";

const DEFAULT_LIST_LIMIT = 6;
const MAX_LIST_LIMIT = 20;

const CONTRACT_STATUS_ORDER = Object.freeze([
  CONTRACT_STATUS.PENDING,
  CONTRACT_STATUS.RUNNING,
  CONTRACT_STATUS.AWAITING_INPUT,
  CONTRACT_STATUS.COMPLETED,
  CONTRACT_STATUS.FAILED,
  CONTRACT_STATUS.ABANDONED,
  CONTRACT_STATUS.CANCELLED,
]);

function clampListLimit(value) {
  const parsed = Number.parseInt(String(value || ""), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_LIST_LIMIT;
  return Math.min(parsed, MAX_LIST_LIMIT);
}

function countBy(items, resolveKey, {
  seed = [],
  unknownKey = "unknown",
} = {}) {
  const counts = Object.fromEntries(seed.map((key) => [key, 0]));
  for (const item of Array.isArray(items) ? items : []) {
    const key = normalizeString(resolveKey(item)) || unknownKey;
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

function deriveOperatorSurfaceSummary(cliSystemSummary) {
  const surfaces = (Array.isArray(cliSystemSummary?.surfaces) ? cliSystemSummary.surfaces : [])
    .filter((surface) => surface?.source === "admin_surface");
  return {
    counts: {
      total: surfaces.length,
      operatorExecutable: surfaces.filter((surface) => surface?.operatorExecutable === true).length,
      executable: surfaces.filter((surface) => surface?.executable === true).length,
    },
    surfaces,
  };
}

export async function loadSnapshotCoreData({ listLimit = DEFAULT_LIST_LIMIT } = {}) {
  const limit = clampListLimit(listLimit);
  // graph / test reports / automation runtimes 并行加载；graph 经 CLI-system inspect
  // surface 读取，不直读 store（收口旁路）。读出 graph 后再喂给 inspect.graph_loops，
  // 顺序不变、无循环。
  const [agents, graph, testReports, automationRuntimes] = await Promise.all([
    listAgentRegistry(),
    inspectCliSystemSurface({ surfaceId: "inspect.agent_graph" }),
    loadRecentTestReports(),
    // automation runtime states 经 CLI-system inspect surface 读取，不直读 store（收口旁路）。保留原兜底。
    inspectCliSystemSurface({ surfaceId: "inspect.automation_runtime" }).catch(() => []),
  ]);
  // graph loop / loop session 经 CLI-system inspect surface 读取，不直读 store（收口旁路）。
  const loops = await inspectCliSystemSurface({
    surfaceId: "inspect.graph_loops",
    params: { graph },
  });
  const loopSessions = await inspectCliSystemSurface({
    surfaceId: "inspect.loop_sessions",
    params: { loops },
  });
  let harnessRuns;
  try {
    // 经 CLI-system inspect surface 读取 HarnessRun，不直读 store（收口旁路）。
    harnessRuns = await inspectCliSystemSurface({
      surfaceId: "inspect.harness_runs",
      params: { limit },
    });
  } catch {
    harnessRuns = [];
  }
  return { agents, graph, loops, loopSessions, harnessRuns, testReports, automationRuntimes };
}

export async function buildOperatorSnapshot({
  listLimit = DEFAULT_LIST_LIMIT,
} = {}) {
  const limit = clampListLimit(listLimit);
  const [
    coreData,
    drafts,
    workItems,
    systemActionDeliveries,
    schedules,
    agentJoins,
    automations,
    guidanceDriftState,
  ] = await Promise.all([
    loadSnapshotCoreData({ listLimit }),
    // change sets / work items / delivery tickets / schedules / agent joins /
    // automation summary / guidance drift 经 CLI-system inspect surface 读取，
    // 不直读 store（收口旁路）。guidance drift 保留原 catch 兜底。
    inspectCliSystemSurface({ surfaceId: "inspect.change_sets" }),
    inspectCliSystemSurface({ surfaceId: "inspect.work_items" }),
    inspectCliSystemSurface({ surfaceId: "inspect.delivery_tickets" }),
    inspectCliSystemSurface({ surfaceId: "inspect.schedules" }),
    inspectCliSystemSurface({ surfaceId: "inspect.agent_joins" }),
    inspectCliSystemSurface({ surfaceId: "inspect.automation_runtime_summary" }),
    inspectCliSystemSurface({ surfaceId: "inspect.guidance_drift" }).catch(() => null),
  ]);
  // pending signals 经 CLI-system inspect surface 读取，不直读 registry（收口旁路）。保留原兜底。
  const pendingSignalSummary = await inspectCliSystemSurface({
    surfaceId: "inspect.pending_signals",
  }).catch(() => null);
  const { agents, loops, loopSessions, harnessRuns, testReports } = coreData;
  // graph is also available in coreData but not needed by the snapshot output itself
  const activeLoopSession = loopSessions.find((session) => session?.active === true) || null;
  const brokenLoopSessions = loopSessions.filter((session) => session?.runtimeStatus === "broken");
  const recentGraphRouteProgressions = listRecentGraphRouteProgressions(workItems, {
    activeLoopSession,
    limit,
  });
  const latestGraphRouteProgression = recentGraphRouteProgressions[0] || null;

  const cliSystemSummary = summarizeCliSystemSurfaces();
  const surfaceSummary = deriveOperatorSurfaceSummary(cliSystemSummary);
  // test runs 经 CLI-system inspect surface 读取，不直读 registry（收口旁路）。
  const testRuns = await inspectCliSystemSurface({ surfaceId: "inspect.test_runs" });
  const recentRuns = Array.isArray(testRuns?.runs) ? testRuns.runs : [];
  const runtimeSummary = buildRuntimeSummary(limit);
  const recentRuntimeIncidents = listRecentRuntimeIncidents(workItems, { limit });
  const draftRelations = buildDraftRelations(drafts, workItems, systemActionDeliveries.tickets, recentRuns);

  const workItemCounts = countBy(workItems, (workItem) => workItem?.status, {
    seed: CONTRACT_STATUS_ORDER,
  });
  delete workItemCounts[CONTRACT_STATUS.DRAFT];
  const draftCounts = countBy(drafts, (draft) => draft?.status);
  const roleCounts = countBy(agents, (agent) => agent?.role);
  const phaseCounts = countBy(surfaceSummary.surfaces, (surface) => surface?.operatorPhase);

  const activeTestRun = testRuns.runs.find((run) => run.active) || null;
  const attention = [
    ...buildAttentionItems({
      draftCounts,
      workItemCounts,
      systemActionDeliveryCounts: systemActionDeliveries.counts,
      runtimeSummary,
      recentRuntimeIncidents,
      activeTestRun,
      automationCounts: automations.counts,
    }),
    ...buildDraftScopedAttention(drafts, draftRelations, limit),
  ];
  const recentChangeSets = drafts
    .slice(0, limit)
    .map((draft) => summarizeDraftWithRelations(draft, draftRelations.get(draft.id), limit));
  const workQueue = buildWorkQueue(recentChangeSets, limit);

  // ⑤ Phase4: operator 自动提案（suggest-only）。从 automation runtime summary 的 ProfileLifecycle
  // 投影派生分级建议，填 #40 控制面右栏；纯建议，人审批后经既有 change-set apply→verify 落地。
  const operatorProposals = operatorAutoPropose({
    profiles: (Array.isArray(automations?.automations) ? automations.automations : []).map((entry) => ({
      automationId: entry?.summary?.id || entry?.id || null,
      profileLifecycle: entry?.summary?.profileLifecycle || null,
      harness: {
        failedModuleCount: entry?.summary?.lastHarnessFailedModuleCount || 0,
        failedModules: Array.isArray(entry?.summary?.lastHarnessRun?.failedModules)
          ? entry.summary.lastHarnessRun.failedModules
          : [],
      },
    })),
  });

  return {
    generatedAt: Date.now(),
    summary: {
      state: resolveSnapshotState(attention, runtimeSummary, activeTestRun),
      attentionCount: attention.length,
      activeWorkItems: (workItemCounts[CONTRACT_STATUS.PENDING] || 0)
        + (workItemCounts[CONTRACT_STATUS.RUNNING] || 0)
        + (workItemCounts[CONTRACT_STATUS.AWAITING_INPUT] || 0),
      activeSystemActionDeliveries: systemActionDeliveries.counts.active || 0,
      enabledSchedules: schedules.counts.enabled || 0,
      readyAgentJoins: agentJoins.counts.ready || 0,
      draftAgentJoins: agentJoins.counts.draft || 0,
      enabledAutomations: automations.counts.enabled || 0,
      activeAutomations: automations.counts.running || 0,
      guardedAutomations: automations.counts.byExecutionMode?.guarded || 0,
      pendingHarnessAutomations: automations.counts.pendingHarnessAutomations || 0,
      failingHarnessAutomations: automations.counts.failingHarnessAutomations || 0,
      failedHarnessModules: automations.counts.failedHarnessModules || 0,
      activeTrackingSessions: runtimeSummary.tracking.total,
      activeLoopSessionId: activeLoopSession?.id || null,
      latestGraphRouteProgressionContractId: latestGraphRouteProgression?.contractId || null,
      latestGraphRouteProgressionOutcome: latestGraphRouteProgression?.outcome || null,
      recentRuntimeIncidentCount: recentRuntimeIncidents.length,
      registeredLoopCount: loops.length,
      queueDepth: runtimeSummary.queueDepth,
      activeTestRunId: activeTestRun?.id || null,
      operatorProposalCount: operatorProposals.length,
    },
    attention,
    operatorProposals,
    agents: {
      counts: {
        total: agents.length,
        byRole: roleCounts,
        constrained: agents.filter((agent) => agent?.constraints && Object.keys(agent.constraints).length > 0).length,
      },
      roster: agents
        .map(summarizeAgent)
        .sort((left, right) => left.id.localeCompare(right.id)),
    },
    surfaces: {
      counts: {
        ...surfaceSummary.counts,
        executable: surfaceSummary.surfaces.filter((surface) => surface.executable === true).length,
      },
      byPhase: phaseCounts,
      actions: surfaceSummary.surfaces
        .filter((surface) => (
          surface.stage === "apply"
          && surface.status === "active"
          && surface.operatorExecutable === true
        ))
        .slice(0, limit)
        .map(summarizeSurface),
      verification: surfaceSummary.surfaces
        .filter((surface) => surface.stage === "verify" && surface.status === "active")
        .slice(0, limit)
        .map(summarizeSurface),
    },
    cliSystem: {
      counts: cliSystemSummary.counts,
      surfaces: cliSystemSummary.surfaces
        .slice(0, limit)
        .map(summarizeSurface),
    },
    changeSets: {
      counts: {
        total: drafts.length,
        byStatus: draftCounts,
      },
      recent: recentChangeSets,
      workQueue,
    },
    workItems: {
      counts: workItemCounts,
      active: workItems
        .filter((workItem) => (
          [
            CONTRACT_STATUS.PENDING,
            CONTRACT_STATUS.RUNNING,
            CONTRACT_STATUS.AWAITING_INPUT,
          ].includes(workItem?.status)
        ))
        .slice(0, limit)
        .map(summarizeWorkItem),
      recentFailures: workItems
        .filter((workItem) => workItem?.status === CONTRACT_STATUS.FAILED)
        .slice(0, limit)
        .map(summarizeWorkItem),
    },
    systemActionDeliveries: {
      counts: systemActionDeliveries.counts,
      active: systemActionDeliveries.tickets
        .filter((ticket) => ticket?.status !== "resolved")
        .slice(0, limit)
        .map(summarizeSystemActionDeliveryTicket),
    },
    schedules: {
      counts: schedules.counts,
      active: schedules.schedules
        .filter((schedule) => schedule?.enabled === true)
        .slice(0, limit)
        .map(summarizeSchedule),
      recent: schedules.schedules
        .slice(0, limit)
        .map(summarizeSchedule),
    },
    agentJoins: {
      counts: agentJoins.counts,
      ready: agentJoins.agentJoins
        .filter((agentJoin) => agentJoin?.summary?.status === "ready")
        .slice(0, limit)
        .map(summarizeAgentJoin),
      recent: agentJoins.agentJoins
        .slice(0, limit)
        .map(summarizeAgentJoin),
    },
    automations: {
      counts: automations.counts,
      active: automations.automations
        .filter((automation) => automation?.runtime?.status === "running")
        .slice(0, limit)
        .map(summarizeAutomation),
      recent: automations.automations
        .slice(0, limit)
        .map(summarizeAutomation),
    },
    loops: {
      counts: {
        registered: loops.length,
        active: loops.filter((loop) => loop?.active === true).length,
        sessions: loopSessions.length,
        brokenSessions: brokenLoopSessions.length,
      },
      activeSession: activeLoopSession ? summarizeLoopSession(activeLoopSession) : null,
      latestProgression: latestGraphRouteProgression,
      recentProgressions: recentGraphRouteProgressions,
      registered: loops.slice(0, limit).map(summarizeLoop),
      sessions: loopSessions.slice(0, limit).map(summarizeLoopSession),
    },
    tests: {
      activeRun: activeTestRun ? summarizeTestRun(activeTestRun) : null,
      recentRuns: recentRuns.slice(0, limit).map(summarizeTestRun),
      presets: testRuns.presets,
    },
    testReports: {
      total: testReports.length,
      reports: testReports,
    },
    harnessRuns: {
      counts: { total: harnessRuns.length, byStatus: countBy(harnessRuns, (run) => run?.status) },
      recent: harnessRuns.map(summarizeHarnessRun),
    },
    reviewerResults: buildReviewerResultsSnapshot(automations),
    automationDecisions: buildAutomationDecisionsSnapshot(automations),
    runtime: {
      ...runtimeSummary,
      recentIncidents: recentRuntimeIncidents,
    },
    guidanceDrift: {
      state: guidanceDriftState,
      links: {
        discovery: "/watchdog/agents/discovery",
        takeover: "/watchdog/agents/guidance/takeover",
      },
    },
    pendingSignals: pendingSignalSummary,
    links: {
      operatorSnapshot: "/watchdog/operator-snapshot",
      cliSystemSurfaces: "/watchdog/cli-system/surfaces",
      agents: "/watchdog/agents",
      adminSurfaces: "/watchdog/admin-surfaces",
      adminChangeSets: "/watchdog/admin-change-sets",
      workItems: "/watchdog/work-items",
      schedules: "/watchdog/schedules",
      agentJoins: "/watchdog/agent-joins/registry",
      automations: "/watchdog/automations",
      systemActionDeliveryTickets: "/watchdog/system-action-delivery-tickets",
      graph: "/watchdog/graph",
      graphLoops: "/watchdog/graph/loops",
      graphLoopSessions: "/watchdog/graph/loop-sessions",
      testRuns: "/watchdog/test-runs",
      runtime: "/watchdog/runtime",
    },
  };
}
