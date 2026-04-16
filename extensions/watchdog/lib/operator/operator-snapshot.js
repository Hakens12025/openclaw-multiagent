// lib/operator-snapshot.js — Core data loading & operator snapshot assembly

import { listAdminChangeSets } from "../admin/admin-change-sets.js";
import { loadGraph } from "../agent/agent-graph.js";
import { summarizeAgentJoinRegistry } from "../agent/agent-join-registry.js";
import { summarizeAdminSurfaces } from "../admin/admin-surface-registry.js";
import { listAutomationRuntimeStates, summarizeAutomationRuntimeRegistry } from "../automation/automation-runtime.js";
import { listAgentRegistry } from "../capability/capability-registry.js";
import { summarizeCliSystemSurfaces } from "../cli-system/cli-surface-registry.js";
import { listLifecycleWorkItems } from "../contracts.js";
import { listResolvedGraphLoops } from "../loop/graph-loop-registry.js";
import { listRecentHarnessRuns } from "../harness/harness-run-store.js";
import { listResolvedLoopSessions } from "../loop/loop-session-store.js";
import { normalizeString } from "../core/normalize.js";
import {
  buildAttentionItems,
  buildAutomationDecisionsSnapshot,
  buildReviewerResultsSnapshot,
  buildRuntimeSummary,
  listRecentPipelineProgressions,
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
import { summarizeSystemActionDeliveryTickets } from "../routing/delivery-system-action-ticket.js";
import { summarizeScheduleRegistry } from "../schedule/schedule-registry.js";
import { listTestRuns } from "../test-runs.js";

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

export async function loadSnapshotCoreData({ listLimit = DEFAULT_LIST_LIMIT } = {}) {
  const limit = clampListLimit(listLimit);
  const [agents, graph, testReports, automationRuntimes] = await Promise.all([
    listAgentRegistry(),
    loadGraph(),
    loadRecentTestReports(),
    listAutomationRuntimeStates().catch(() => []),
  ]);
  const loops = await listResolvedGraphLoops({ graph });
  const loopSessions = await listResolvedLoopSessions({ loops });
  let harnessRuns;
  try {
    harnessRuns = await listRecentHarnessRuns(limit);
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
  ] = await Promise.all([
    loadSnapshotCoreData({ listLimit }),
    listAdminChangeSets(),
    listLifecycleWorkItems(),
    summarizeSystemActionDeliveryTickets(),
    summarizeScheduleRegistry(),
    summarizeAgentJoinRegistry(),
    summarizeAutomationRuntimeRegistry(),
  ]);
  const { agents, loops, loopSessions, harnessRuns, testReports } = coreData;
  // graph is also available in coreData but not needed by the snapshot output itself
  const activeLoopSession = loopSessions.find((session) => session?.active === true) || null;
  const brokenLoopSessions = loopSessions.filter((session) => session?.runtimeStatus === "broken");
  const recentPipelineProgressions = listRecentPipelineProgressions(workItems, {
    activeLoopSession,
    limit,
  });
  const latestPipelineProgression = recentPipelineProgressions[0] || null;

  const surfaceSummary = summarizeAdminSurfaces();
  const cliSystemSummary = summarizeCliSystemSurfaces();
  const testRuns = listTestRuns();
  const recentRuns = Array.isArray(testRuns?.runs) ? testRuns.runs : [];
  const runtimeSummary = buildRuntimeSummary(limit);
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
      activeTestRun,
      automationCounts: automations.counts,
    }),
    ...buildDraftScopedAttention(drafts, draftRelations, limit),
  ];
  const recentChangeSets = drafts
    .slice(0, limit)
    .map((draft) => summarizeDraftWithRelations(draft, draftRelations.get(draft.id), limit));
  const workQueue = buildWorkQueue(recentChangeSets, limit);

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
      latestPipelineProgressionContractId: latestPipelineProgression?.contractId || null,
      latestPipelineProgressionOutcome: latestPipelineProgression?.outcome || null,
      registeredLoopCount: loops.length,
      queueDepth: runtimeSummary.queueDepth,
      activeTestRunId: activeTestRun?.id || null,
    },
    attention,
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
      latestProgression: latestPipelineProgression,
      recentProgressions: recentPipelineProgressions,
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
    runtime: runtimeSummary,
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
