// lib/operator-snapshot-draft-relations.js — Draft relation buckets, recommended actions, work queue

import { normalizeString } from "../core/normalize.js";
import { CONTRACT_STATUS } from "../core/runtime-status.js";
import { summarizeWorkItem, summarizeDraft, summarizeSystemActionDeliveryTicket } from "./operator-snapshot-summarizers.js";
import { summarizeTestRun } from "./operator-snapshot-tests.js";

function createDraftRelationBucket(draft) {
  return {
    draftId: draft?.id || "unknown",
    surfaceId: draft?.surfaceId || null,
    title: draft?.title || null,
    status: draft?.status || "draft",
    activeWorkItems: [],
    failedWorkItems: [],
    activeSystemActionDeliveries: [],
    relatedTestRuns: [],
  };
}

export function buildDraftRelations(drafts, workItems, systemActionDeliveryTickets, testRuns) {
  const byDraftId = new Map(
    drafts.map((draft) => [draft.id, createDraftRelationBucket(draft)]),
  );

  for (const workItem of workItems) {
    const originDraftId = normalizeString(workItem?.operatorContext?.originDraftId);
    if (!originDraftId || !byDraftId.has(originDraftId)) continue;
    const bucket = byDraftId.get(originDraftId);
    if ([CONTRACT_STATUS.PENDING, CONTRACT_STATUS.RUNNING, CONTRACT_STATUS.AWAITING_INPUT].includes(workItem?.status)) {
      bucket.activeWorkItems.push(workItem);
    } else if (workItem?.status === CONTRACT_STATUS.FAILED) {
      bucket.failedWorkItems.push(workItem);
    }
  }

  for (const ticket of Array.isArray(systemActionDeliveryTickets) ? systemActionDeliveryTickets : []) {
    const originDraftId = normalizeString(ticket?.metadata?.originDraftId);
    if (!originDraftId || !byDraftId.has(originDraftId) || ticket?.status === "resolved") continue;
    byDraftId.get(originDraftId).activeSystemActionDeliveries.push(ticket);
  }

  for (const run of Array.isArray(testRuns) ? testRuns : []) {
    const originDraftId = normalizeString(run?.originDraftId);
    if (!originDraftId || !byDraftId.has(originDraftId)) continue;
    byDraftId.get(originDraftId).relatedTestRuns.push(run);
  }

  return byDraftId;
}

function resolveDraftNextAction(draft, relation) {
  if ((relation?.failedWorkItems?.length || 0) > 0) return "inspect_related_work_item_failures";
  if ((relation?.relatedTestRuns || []).some((run) => run?.active)) return "watch_verification_run";
  if ((relation?.activeSystemActionDeliveries?.length || 0) > 0) return "watch_system_action_delivery";
  if ((relation?.activeWorkItems?.length || 0) > 0) return "track_related_work_items";
  if (draft?.status === "draft" || draft?.status === "previewed") return "review_and_execute";
  if (draft?.status === "applied") return "verify_or_observe";
  if (draft?.status === "verification_failed" || draft?.status === "failed") return "inspect_change_set";
  return "none";
}

function getLatestRelatedTestRun(relation) {
  return [...(relation?.relatedTestRuns || [])]
    .sort((left, right) => {
      const leftActive = left?.active === true;
      const rightActive = right?.active === true;
      if (leftActive !== rightActive) return leftActive ? -1 : 1;
      return (right?.startedAt || right?.finishedAt || 0) - (left?.startedAt || left?.finishedAt || 0);
    })[0] || null;
}

function buildRecommendedAction(draft, relation) {
  const actionId = resolveDraftNextAction(draft, relation);
  const draftId = draft?.id || null;
  const latestRun = getLatestRelatedTestRun(relation);

  switch (actionId) {
    case "inspect_related_work_item_failures":
      return {
        actionId,
        label: "查看失败 Work Item",
        summary: "先检查同源 work item 的失败原因，再决定是否修改 draft 或重试。",
        nextSurfaceId: "work_items.list",
        nextMethod: "GET",
        nextPath: "/watchdog/work-items",
        targetDraftId: draftId,
      };
    case "watch_verification_run":
      return {
        actionId,
        label: "观察验证 Run",
        summary: "验证已经启动，优先跟踪测试进度和失败用例。",
        nextSurfaceId: latestRun?.id ? "test_runs.detail" : "test_runs.list",
        nextMethod: "GET",
        nextPath: latestRun?.id
          ? `/watchdog/test-runs/detail?id=${encodeURIComponent(latestRun.id)}`
          : "/watchdog/test-runs",
        targetDraftId: draftId,
        targetRunId: latestRun?.id || null,
      };
    case "watch_system_action_delivery":
      return {
        actionId,
        label: "观察 Delivery Ticket",
        summary: "当前 draft 仍在等待 system_action delivery 送达，先确认 ticket 是否被正确消费。",
        nextSurfaceId: "system_action_delivery_tickets.list",
        nextMethod: "GET",
        nextPath: "/watchdog/system-action-delivery-tickets",
        targetDraftId: draftId,
      };
    case "track_related_work_items":
      return {
        actionId,
        label: "跟踪关联 Work Item",
        summary: "当前 draft 已经派生出运行中的 work item，优先盯生命周期和 assignee 进度。",
        nextSurfaceId: "work_items.list",
        nextMethod: "GET",
        nextPath: "/watchdog/work-items",
        targetDraftId: draftId,
      };
    case "review_and_execute":
      return {
        actionId,
        label: "预览并执行草稿",
        summary: "先看 preview，再决定是否执行 change-set。",
        nextSurfaceId: "admin_change_sets.preview",
        nextMethod: "GET",
        nextPath: draftId
          ? `/watchdog/admin-change-sets/preview?id=${encodeURIComponent(draftId)}`
          : "/watchdog/admin-change-sets/preview",
        followUpSurfaceId: "admin_change_sets.execute",
        followUpMethod: "POST",
        followUpPath: "/watchdog/admin-change-sets/execute",
        targetDraftId: draftId,
      };
    case "verify_or_observe":
      return {
        actionId,
        label: "启动或观察验证",
        summary: latestRun
          ? "这个 draft 已有关联测试，先看验证结果是否需要回挂。"
          : "这个 draft 已应用但还缺验证，下一步应发起 test run 或回挂已有证据。",
        nextSurfaceId: latestRun?.id ? "test_runs.detail" : "test_runs.start",
        nextMethod: latestRun?.id ? "GET" : "POST",
        nextPath: latestRun?.id
          ? `/watchdog/test-runs/detail?id=${encodeURIComponent(latestRun.id)}`
          : "/watchdog/test-runs/start",
        followUpSurfaceId: latestRun?.id ? "admin_change_sets.attach_verification" : "admin_change_sets.attach_verification",
        followUpMethod: "POST",
        followUpPath: "/watchdog/admin-change-sets/verification",
        targetDraftId: draftId,
        targetRunId: latestRun?.id || null,
      };
    case "inspect_change_set":
      return {
        actionId,
        label: "检查草稿明细",
        summary: "先回到 draft detail 看 payload、execution 和 verification 记录。",
        nextSurfaceId: "admin_change_sets.detail",
        nextMethod: "GET",
        nextPath: draftId
          ? `/watchdog/admin-change-sets/detail?id=${encodeURIComponent(draftId)}`
          : "/watchdog/admin-change-sets/detail",
        targetDraftId: draftId,
      };
    default:
      return null;
  }
}

export function summarizeDraftWithRelations(draft, relation, limit) {
  const base = summarizeDraft(draft);
  const recommendedAction = buildRecommendedAction(draft, relation);
  return {
    ...base,
    nextAction: resolveDraftNextAction(draft, relation),
    recommendedAction,
    related: {
      activeWorkItemCount: relation?.activeWorkItems?.length || 0,
      failedWorkItemCount: relation?.failedWorkItems?.length || 0,
      activeSystemActionDeliveryCount: relation?.activeSystemActionDeliveries?.length || 0,
      relatedTestRunCount: relation?.relatedTestRuns?.length || 0,
      activeWorkItems: (relation?.activeWorkItems || []).slice(0, limit).map(summarizeWorkItem),
      failedWorkItems: (relation?.failedWorkItems || []).slice(0, limit).map(summarizeWorkItem),
      activeSystemActionDeliveries: (relation?.activeSystemActionDeliveries || []).slice(0, limit).map(summarizeSystemActionDeliveryTicket),
      recentTestRuns: (relation?.relatedTestRuns || []).slice(0, limit).map(summarizeTestRun),
    },
    links: {
      detail: `/watchdog/admin-change-sets/detail?id=${encodeURIComponent(base.id)}`,
      preview: `/watchdog/admin-change-sets/preview?id=${encodeURIComponent(base.id)}`,
      drafts: "/watchdog/admin-change-sets",
      workItems: "/watchdog/work-items",
      systemActionDeliveries: "/watchdog/system-action-delivery-tickets",
      testRuns: "/watchdog/test-runs",
    },
  };
}

export function buildDraftScopedAttention(drafts, draftRelations, limit) {
  const items = [];
  for (const draft of drafts.slice(0, limit)) {
    const relation = draftRelations.get(draft.id);
    if (!relation) continue;
    if ((relation.failedWorkItems?.length || 0) > 0) {
      items.push({
        severity: "warning",
        area: "change_sets",
        targetType: "draft",
        targetId: draft.id,
        count: relation.failedWorkItems.length,
        summary: `draft ${draft.id} 关联了失败 work item。`,
        path: `/watchdog/admin-change-sets/detail?id=${encodeURIComponent(draft.id)}`,
      });
      continue;
    }
    if ((relation.activeSystemActionDeliveries?.length || 0) > 0) {
      items.push({
        severity: "info",
        area: "change_sets",
        targetType: "draft",
        targetId: draft.id,
        count: relation.activeSystemActionDeliveries.length,
        summary: `draft ${draft.id} 仍在等待 system_action delivery。`,
        path: `/watchdog/admin-change-sets/detail?id=${encodeURIComponent(draft.id)}`,
      });
      continue;
    }
    if ((relation.relatedTestRuns || []).some((run) => run?.active)) {
      items.push({
        severity: "info",
        area: "change_sets",
        targetType: "draft",
        targetId: draft.id,
        count: relation.relatedTestRuns.filter((run) => run?.active).length,
        summary: `draft ${draft.id} 存在进行中的验证 test run。`,
        path: `/watchdog/admin-change-sets/detail?id=${encodeURIComponent(draft.id)}`,
      });
      continue;
    }
    if ((relation.activeWorkItems?.length || 0) > 0) {
      items.push({
        severity: "info",
        area: "change_sets",
        targetType: "draft",
        targetId: draft.id,
        count: relation.activeWorkItems.length,
        summary: `draft ${draft.id} 存在进行中的关联 work item。`,
        path: `/watchdog/admin-change-sets/detail?id=${encodeURIComponent(draft.id)}`,
      });
    }
  }
  return items;
}

export function buildWorkQueue(changeSets, limit) {
  return (Array.isArray(changeSets) ? changeSets : [])
    .filter((draft) => draft?.recommendedAction)
    .slice(0, limit)
    .map((draft) => ({
      draftId: draft.id,
      title: draft.title || draft.surfaceId || draft.id,
      status: draft.status || "draft",
      nextAction: draft.nextAction || null,
      recommendedAction: draft.recommendedAction,
      related: {
        activeWorkItemCount: draft?.related?.activeWorkItemCount || 0,
        failedWorkItemCount: draft?.related?.failedWorkItemCount || 0,
        activeSystemActionDeliveryCount: draft?.related?.activeSystemActionDeliveryCount || 0,
        relatedTestRunCount: draft?.related?.relatedTestRunCount || 0,
      },
    }));
}
