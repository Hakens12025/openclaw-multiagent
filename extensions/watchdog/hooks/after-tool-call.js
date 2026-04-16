// hooks/after-tool-call.js — Pure observation layer: execution trace, tracking, dispatch chain
// No contract mutation, no inbox ingress, no draft promotion.

import { unlink } from "node:fs/promises";
import { join } from "node:path";
import {
  HOME, MAX_RECENT_TOOL_EVENTS, MAX_TOOL_CALLS,
  agentWorkspace,
} from "../lib/state.js";
import {
  rememberDispatchChainOrigin,
} from "../lib/store/contract-flow-store.js";
import { evictContractSnapshotByPath } from "../lib/store/contract-store.js";
import { getTrackingState } from "../lib/store/tracker-store.js";
import { broadcast, buildProgressPayload } from "../lib/transport/sse.js";
import { writeTaskState } from "../lib/contracts.js";
import { recordStep } from "../lib/store/execution-trace-store.js";
import { normalizeSystemIntent } from "../lib/protocol-primitives.js";
import {
  AGENT_ROLE,
  resolveAgentIdByRole,
} from "../lib/agent/agent-identity.js";
import {
  classifyCanonicalProtocolCommit,
  scheduleProtocolCommitReconcile,
} from "../lib/protocol-commit-reconcile.js";
import { refreshTrackingProjection } from "../lib/stage-projection.js";
import { trackToolCall } from "../lib/loop/loop-detection.js";
import { buildToolActivityCursor } from "../lib/runtime-activity.js";
import { observeCanonicalStageResultCommit } from "../lib/protocol-commit-observer.js";
import { syncTrackingRuntimeStageProgress } from "../lib/runtime-stage-progress.js";
import { buildToolTimelineEvent } from "../lib/tool-timeline.js";

export function resolveToolWriteTargetPath({ agentId, rawPath }) {
  const normalized = String(rawPath || "").replace(/^~/, HOME);
  if (!normalized) return normalized;
  if (normalized.startsWith("/") || /^[A-Za-z]:[\\/]/.test(normalized)) {
    return normalized;
  }
  if (!agentId) return normalized;
  return join(agentWorkspace(agentId), normalized);
}

export function deriveDelegationIntentForEarlyCheck(action) {
  const normalized = normalizeSystemIntent(action);
  return {
    intentType: normalized?.type || null,
    targetAgent: normalized?.params?.targetAgent
      || normalized?.params?.startAgent
      || null,
  };
}

export function register(api, logger, { enqueueFn, wakePlanner }) {
  api.on("after_tool_call", async (event, ctx) => {
    const sessionKey = ctx.sessionKey;
    const agentId = ctx.agentId ?? "unknown";
    const toolName = event.toolName ?? "unknown";
    const params = event.params ?? {};

    // ── Execution trace: record every tool call ──
    const writeTarget = resolveToolWriteTargetPath({
      agentId,
      rawPath: params.path ?? params.file_path ?? params.filePath ?? "",
    });
    recordStep(sessionKey, { tool: toolName, targetPath: writeTarget });

    // ── Loop detection: track repeated identical tool calls ──
    const loopSignal = trackToolCall(sessionKey, toolName, params);
    if (loopSignal === "warn") {
      broadcast("loop_warning", { sessionKey, agentId, toolName, level: "warn", ts: Date.now() });
      logger.warn(`[watchdog] LOOP WARNING: ${agentId} repeated tool call detected (session: ${sessionKey})`);
    } else if (loopSignal === "hard_stop") {
      broadcast("loop_warning", { sessionKey, agentId, toolName, level: "hard_stop", ts: Date.now() });
      logger.error(`[watchdog] LOOP HARD STOP: ${agentId} tool calls will be blocked (session: ${sessionKey})`);
    }

    const canonicalCommitInfo = await classifyCanonicalProtocolCommit({
      agentId,
      targetPath: writeTarget,
      sessionKey,
    });

    // ── Delivery/Inbox consumption detection ──
    if (/^(read|Read)$/i.test(toolName)) {
      const readPath = String(params.file_path ?? params.path ?? "").replace(/^~/, HOME);
      if (readPath.includes("deliveries/") && readPath.endsWith(".json")) {
        setTimeout(async () => {
          try {
            await unlink(readPath);
            evictContractSnapshotByPath(readPath);
            logger.info(`[watchdog] AUTO-DELETED consumed delivery: ${readPath}`);
          }
          catch (e) { logger.warn(`[watchdog] delivery auto-delete failed: ${e.message}`); }
        }, 5000);
      }
      const plannerAgentId = resolveAgentIdByRole(AGENT_ROLE.PLANNER);
      const plannerInboxDir = join(agentWorkspace(plannerAgentId), "inbox");
      if (readPath.startsWith(`${plannerInboxDir}/`) && readPath.endsWith(".json")) {
        setTimeout(async () => {
          try {
            await unlink(readPath);
            evictContractSnapshotByPath(readPath);
            logger.info(`[watchdog] AUTO-DELETED consumed inbox request: ${readPath}`);
          }
          catch (e) { logger.warn(`[watchdog] inbox auto-delete failed: ${e.message}`); }
        }, 10000);
      }
    }

    // ── Dispatch chain tracking ──
    if (/^sessions_send$/i.test(toolName)) {
      let sendTarget = String(params.targetAgent ?? params.agentId ?? params.target ?? params.agent ?? "");
      if (!sendTarget && params.sessionKey) {
        const m = String(params.sessionKey).match(/^agent:([^:]+):/);
        if (m) sendTarget = m[1];
      }
      if (sendTarget) {
        await rememberDispatchChainOrigin(sendTarget, {
          originAgentId: agentId,
          originSessionKey: sessionKey,
          ts: Date.now(),
        }, { logger });
        logger.info(`[watchdog] DISPATCH CHAIN: ${agentId} → ${sendTarget}`);
      }
    }

    // ── Tracking update ──
    const t = getTrackingState(sessionKey);
    if (!t) return;

    const observedAt = Date.now();
    const activityCursor = buildToolActivityCursor(toolName, params, observedAt);
    t.toolCallTotal++;
    if (t.toolCalls.length >= MAX_TOOL_CALLS) t.toolCalls.shift();
    t.toolCalls.push({ tool: toolName, label: activityCursor.label, ts: observedAt });
    if (!Array.isArray(t.recentToolEvents)) {
      t.recentToolEvents = [];
    }
    const toolTimelineEvent = buildToolTimelineEvent({
      index: t.toolCallTotal,
      toolName,
      params,
      result: event.result,
      error: event.error,
      durationMs: event.durationMs,
      runId: ctx.runId ?? event.runId ?? null,
      toolCallId: ctx.toolCallId ?? event.toolCallId ?? null,
      observedAt,
    });
    if (t.recentToolEvents.length >= MAX_RECENT_TOOL_EVENTS) t.recentToolEvents.shift();
    t.recentToolEvents.push(toolTimelineEvent);
    t.lastLabel = activityCursor.label;
    t.activityCursor = activityCursor;

    await syncTrackingRuntimeStageProgress(t, { observedAt });
    await refreshTrackingProjection(t);
    const observedStageResultCommit = canonicalCommitInfo
      ? null
      : await observeCanonicalStageResultCommit({
          trackingState: t,
          agentId,
          observedAt,
        });
    if (t.toolCallTotal % 3 === 0) await writeTaskState(t, logger);

    broadcast("track_progress", buildProgressPayload(t));

    const effectiveCommitInfo = canonicalCommitInfo || observedStageResultCommit;
    if (effectiveCommitInfo) {
      scheduleProtocolCommitReconcile({
        sessionKey,
        agentId,
        api,
        logger,
        enqueueFn,
        wakePlanner,
        commitInfo: effectiveCommitInfo,
      });
    }
  });
}
