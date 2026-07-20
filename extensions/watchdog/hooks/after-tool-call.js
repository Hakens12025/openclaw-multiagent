// hooks/after-tool-call.js — Pure observation layer: execution trace, tracking, dispatch chain
// No contract mutation, no inbox ingress, no draft promotion.

import { unlink } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  HOME, MAX_RECENT_TOOL_EVENTS, TOOL_CALLS_WINDOW_SIZE,
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
import { evaluateTrace } from "../lib/store/execution-trace-store.js";
import { normalizeSystemIntent, RUNTIME_RESULT_FILE } from "../lib/protocol-primitives.js";
import {
  AGENT_ROLE,
  getAgentIdentitySnapshot,
  getAgentRole,
  resolveAgentIdByRole,
} from "../lib/agent/agent-identity.js";
import {
  classifyCanonicalProtocolCommit,
  scheduleProtocolCommitReconcile,
} from "../lib/protocol-commit-reconcile.js";
import { refreshTrackingProjection } from "../lib/stage-projection.js";
import {
  trackToolCall,
  markSessionHardStopped,
  getSessionHardStopReason,
  HARD_STOP_REASON,
} from "../lib/loop/loop-detection.js";
import { resolveLoopEpochKey } from "../lib/loop/loop-epoch-key.js";
import {
  resolveMaxToolCallsFromPolicy,
  resolveMaxOutputBytesFromPolicy, // FIX(A4-output-length-stop): output-byte budget resolver
} from "../lib/execution-policy-defaults.js";
import { buildToolActivityCursor } from "../lib/runtime-activity.js";
import { observeCanonicalRuntimeResultCommit } from "../lib/protocol-commit-observer.js";
import { syncTrackingRuntimeStageProgress } from "../lib/runtime-stage-progress.js";
import {
  appendToolTimelineEvent,
  buildToolTimelineEvent,
} from "../lib/tool-timeline.js";
import { canonicalizeContractOutputPath } from "../lib/runtime-contract-output-alias.js";
import { isToolOutcomeError, measureToolResultBytes } from "../lib/runtime-user-facing-output.js"; // FIX(A4-output-length-stop): measure tool result bytes
import {
  getExecutionIncident,
  upsertExecutionIncident,
} from "../lib/runtime/execution-incident-store.js";
import { evaluateRuntimeFault } from "../lib/runtime/runtime-fault-evaluator.js";
import { terminalizeHardStoppedRuntimeSession } from "../lib/runtime/hard-stop-terminalize.js";

function deriveLoopHardStopCommitInfo({ agentId, trackingState, traceVerdict }) {
  const fallbackRuntimeResultPath = agentId
    ? join(agentWorkspace(agentId), "outbox", RUNTIME_RESULT_FILE)
    : "";
  const contractOutput = String(trackingState?.contract?.output || "").trim();
  const commitPath = contractOutput || fallbackRuntimeResultPath;
  if (!commitPath) {
    return null;
  }
  return {
    type: traceVerdict?.outputCommitted === true ? "loop_hard_stop_output" : "loop_hard_stop_terminal",
    fileName: basename(commitPath),
    commitPath,
    allowMissing: traceVerdict?.outputCommitted !== true,
  };
}

export function resolveToolWriteTargetPath({ agentId, rawPath, trackingState = null }) {
  const normalized = String(rawPath || "").replace(/^~/, HOME);
  if (!normalized) return normalized;
  const resolvedPath = normalized.startsWith("/") || /^[A-Za-z]:[\\/]/.test(normalized)
    ? normalized
    : !agentId
      ? normalized
      : join(agentWorkspace(agentId), normalized);
  return canonicalizeContractOutputPath({
    agentId,
    rawPath: resolvedPath,
    contractOutput: trackingState?.contract?.output || "",
  });
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

function resolveSameToolLoopEvidence(loopSignal, hardStopReason) {
  if (loopSignal === "warn") {
    return 3;
  }
  if (loopSignal === "hard_stop" && hardStopReason === HARD_STOP_REASON.REPEAT_THRESHOLD) {
    return 5;
  }
  return 0;
}

function resolveIncidentTerminationReason(incidentVerdict, hardStopReason, wrongActorActivation) {
  if (wrongActorActivation) {
    return "wrong_actor_activation";
  }
  if (incidentVerdict?.firstFaultCode === "max_tool_calls" || hardStopReason === HARD_STOP_REASON.MAX_TOOL_CALLS) {
    return HARD_STOP_REASON.MAX_TOOL_CALLS;
  }
  return incidentVerdict?.firstFaultCode || hardStopReason || null;
}

function resolveObservedToolPath(agentId, rawPath) {
  const normalized = String(rawPath || "").replace(/^~/, HOME).trim();
  if (!normalized) return "";
  if (normalized.startsWith("/") || /^[A-Za-z]:[\\/]/.test(normalized)) {
    return normalized;
  }
  return agentId ? join(agentWorkspace(agentId), normalized) : normalized;
}

export function register(api, logger) {
  api.on("after_tool_call", async (event, ctx) => {
    const sessionKey = ctx.sessionKey;
    const agentId = ctx.agentId ?? "unknown";
    const toolName = event.toolName ?? "unknown";
    const params = event.params ?? {};
    const trackingState = getTrackingState(sessionKey);

    // ── Execution trace: record every tool call ──
    const writeTarget = resolveToolWriteTargetPath({
      agentId,
      rawPath: params.path ?? params.file_path ?? params.filePath ?? "",
      trackingState,
    });
    const writeSucceeded = !isToolOutcomeError(event);
    recordStep(sessionKey, {
      tool: toolName,
      targetPath: writeTarget,
      writeSucceeded,
    });

    // ── Loop detection: track repeated identical tool calls ──
    const epochKey = resolveLoopEpochKey(trackingState) || sessionKey;
    const loopSignal = trackToolCall(epochKey, toolName, params);
    if (loopSignal === "warn" || loopSignal === "hard_stop") {
      const loopWarningTs = Date.now();
      const startedAt = Number(trackingState?.startTs || trackingState?.startedAt || 0);
      // trackToolCall runs before t.toolCallTotal++, so the post-call counter is +1.
      broadcast("loop_warning", {
        sessionKey,
        epochKey,
        agentId,
        agentRole: getAgentRole(agentId) || null,
        contractId: trackingState?.contract?.id || null,
        toolName,
        level: loopSignal,
        toolCallTotalAfter: Number((trackingState?.toolCallTotal || 0) + 1),
        elapsedMs: startedAt > 0 ? Math.max(0, loopWarningTs - startedAt) : null,
        ts: loopWarningTs,
      });
      const [label, logFn] = loopSignal === "warn"
        ? ["LOOP WARNING: repeated tool call detected", logger.warn]
        : ["LOOP HARD STOP: tool calls will be blocked", logger.error];
      logFn(`[watchdog] ${label} — ${agentId} (session: ${sessionKey})`);
    }
    const traceVerdict = evaluateTrace(sessionKey);

    const canonicalCommitInfo = await classifyCanonicalProtocolCommit({
      agentId,
      targetPath: writeTarget,
      sessionKey,
    });
    const loopHardStopCommitInfo = loopSignal === "hard_stop"
      ? deriveLoopHardStopCommitInfo({
          agentId,
          trackingState,
          traceVerdict,
        })
      : null;

    // ── Delivery/Inbox consumption detection ──
    if (/^(read|Read)$/i.test(toolName) && !isToolOutcomeError(event)) {
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
    const t = trackingState;
    if (!t) return;
    const actorIdentity = getAgentIdentitySnapshot(agentId);

    const observedAt = Date.now();
    const activityCursor = buildToolActivityCursor(toolName, params, observedAt);
    t.toolCallTotal++;
    if (/^(read|Read)$/i.test(toolName) && !isToolOutcomeError(event)) {
      const ownInboxContractPath = agentId
        ? join(agentWorkspace(agentId), "inbox", "contract.json")
        : "";
      const observedReadPath = resolveObservedToolPath(
        agentId,
        params.path ?? params.file_path ?? params.filePath ?? "",
      );
      if (ownInboxContractPath && observedReadPath === ownInboxContractPath) {
        t.ownInboxContractReadAt = observedAt;
      }
    }

    // executionPolicy.maxToolCalls hard-stop budget. trackingState.executionPolicy
    // is snapshotted at before_agent_start so the resolve here is a plain lookup.
    const maxToolCallsBudget = resolveMaxToolCallsFromPolicy(t?.executionPolicy);
    if (Number(t.toolCallTotal || 0) >= maxToolCallsBudget) {
      markSessionHardStopped(resolveLoopEpochKey(t) || sessionKey, HARD_STOP_REASON.MAX_TOOL_CALLS);
    }
    // FIX(A4-output-length-stop): after_tool_call bounded call COUNT but never total output VOLUME ->
    // accumulate result bytes per session and hard-stop once the output-byte budget is crossed.
    // Pure observation, identical shape to the maxToolCalls marking above (no contract mutation here).
    t.outputBytesTotal = Number(t.outputBytesTotal || 0) + measureToolResultBytes(event);
    if (t.outputBytesTotal >= resolveMaxOutputBytesFromPolicy(t?.executionPolicy)) {
      markSessionHardStopped(resolveLoopEpochKey(t) || sessionKey, HARD_STOP_REASON.OUTPUT_BUDGET_EXHAUSTED);
    }
    if (t.toolCalls.length >= TOOL_CALLS_WINDOW_SIZE) t.toolCalls.shift();
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
    appendToolTimelineEvent(t.recentToolEvents, toolTimelineEvent, {
      maxEvents: MAX_RECENT_TOOL_EVENTS,
    });
    t.lastLabel = activityCursor.label;
    t.activityCursor = activityCursor;

    await syncTrackingRuntimeStageProgress(t, { observedAt });
    await refreshTrackingProjection(t);
    const observedRuntimeResultCommit = canonicalCommitInfo
      ? null
      : await observeCanonicalRuntimeResultCommit({
          trackingState: t,
          agentId,
          observedAt,
        });
    const hardStopReason = getSessionHardStopReason(epochKey);
    const wrongActorActivation = actorIdentity?.plane === "control_plane" && t?.contract?.id
      ? { agentId, plane: actorIdentity.plane }
      : null;
    const priorIncident = getExecutionIncident({
      contractId: t?.contract?.id || null,
      epochKey,
      sessionKey,
    });
    const incidentVerdict = evaluateRuntimeFault({
      toolLoop: {
        sameToolSameInputCount: resolveSameToolLoopEvidence(loopSignal, hardStopReason),
        toolName,
      },
      hardStopReason,
      progress: {
        hasFormalProgress: Boolean(
          canonicalCommitInfo
          || observedRuntimeResultCommit
          || traceVerdict?.outputCommitted
          || traceVerdict?.systemActionSeen
        ),
      },
      actor: {
        agentId,
        plane: actorIdentity?.plane || "runtime",
      },
      wrongActorActivation,
      priorIncident,
    });
    if (incidentVerdict.rootFault) {
      const incident = upsertExecutionIncident({
        contractId: t?.contract?.id || null,
        epochKey,
        sessionKey,
        agentId,
        rootFault: incidentVerdict.rootFault,
        firstFaultCode: incidentVerdict.firstFaultCode,
        amplifiers: incidentVerdict.amplifiers,
        status: incidentVerdict.terminationMode === "terminate_with_diagnosis" ? "fail_fast" : "open",
        terminationMode: incidentVerdict.terminationMode,
        terminationReason: resolveIncidentTerminationReason(
          incidentVerdict,
          hardStopReason,
          wrongActorActivation,
        ),
      });
      t.executionIncident = incident;
    }
    const hardStopTerminalization = hardStopReason
      ? await terminalizeHardStoppedRuntimeSession({
          agentId,
          sessionKey,
          trackingState: t,
          api,
          logger,
        })
      : null;
    if (hardStopTerminalization?.terminalized) {
      return;
    }
    if (t.toolCallTotal % 3 === 0) await writeTaskState(t, logger);

    broadcast("track_progress", buildProgressPayload(t));

    const effectiveCommitInfo = canonicalCommitInfo || observedRuntimeResultCommit || loopHardStopCommitInfo;
    if (effectiveCommitInfo) {
      scheduleProtocolCommitReconcile({
        sessionKey,
        agentId,
        api,
        logger,
        commitInfo: effectiveCommitInfo,
      });
    }
  });
}
