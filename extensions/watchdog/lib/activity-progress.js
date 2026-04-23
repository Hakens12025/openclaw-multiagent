import { CONTRACT_STATUS } from "./core/runtime-status.js";

export const LOCAL_ACTIVITY_PHASES = Object.freeze(["接手", "执行", "收口"]);

function normalizeObject(value) {
  return value && typeof value === "object" ? value : null;
}

function normalizeEvents(entries) {
  return Array.isArray(entries) ? entries.filter((entry) => entry && typeof entry === "object") : [];
}

function hasLocalActivity(trackingState) {
  return Boolean(
    normalizeEvents(trackingState?.recentToolEvents).length > 0
    || normalizeObject(trackingState?.activityCursor)
    || hasOutputArtifactSignal(trackingState)
  );
}

function hasOpaqueActivityWithoutEvidence(trackingState) {
  return Boolean(
    (Number.isFinite(trackingState?.toolCallTotal) && trackingState.toolCallTotal > 0)
    || (Array.isArray(trackingState?.toolCalls) && trackingState.toolCalls.length > 0)
  ) && !hasLocalActivity(trackingState);
}

function hasEstablishedExecution(trackingState) {
  const toolCallTotal = Number.isFinite(trackingState?.toolCallTotal) ? trackingState.toolCallTotal : 0;
  if (toolCallTotal >= 2) return true;
  return normalizeEvents(trackingState?.recentToolEvents).length >= 2;
}

function hasOutputArtifactSignal(trackingState) {
  const outputArtifact = normalizeObject(trackingState?.runtimeObservation)?.outputArtifact;
  if (!normalizeObject(outputArtifact)) return false;
  return outputArtifact.isScaffoldOnly !== true;
}

function hasClosureSignal(trackingState) {
  if (hasOutputArtifactSignal(trackingState)) return true;

  const recentEvents = normalizeEvents(trackingState?.recentToolEvents);
  if (recentEvents.some((entry) => entry.kind === "write_local" || entry.kind === "dispatch")) {
    return true;
  }

  const activityCursor = normalizeObject(trackingState?.activityCursor);
  return activityCursor?.kind === "write_local" || activityCursor?.kind === "dispatch";
}

function buildProgressShape({ pct, currentPhase }) {
  const total = LOCAL_ACTIVITY_PHASES.length;
  const normalizedPct = Math.max(0, Math.min(100, Math.trunc(pct || 0)));
  const completedCount = normalizedPct >= 100
    ? total
    : normalizedPct >= 80
      ? 2
      : normalizedPct >= 40
        ? 1
        : 0;

  return {
    source: "agent_local_activity",
    phases: [...LOCAL_ACTIVITY_PHASES],
    completedPhases: LOCAL_ACTIVITY_PHASES.slice(0, completedCount),
    currentPhase,
    currentPhaseIndex: normalizedPct >= 100
      ? total
      : normalizedPct >= 80
        ? 2
        : normalizedPct >= 40
          ? 1
          : 0,
    cursor: `${completedCount}/${total}`,
    pct: normalizedPct,
    total,
  };
}

export function deriveTrackingActivityProgress(trackingState) {
  const status = trackingState?.status || trackingState?.contract?.status || null;

  if (status === CONTRACT_STATUS.COMPLETED) {
    return buildProgressShape({
      pct: 100,
      currentPhase: "已完成",
    });
  }

  if (hasOpaqueActivityWithoutEvidence(trackingState)) {
    return null;
  }

  if (!hasLocalActivity(trackingState)) {
    return buildProgressShape({
      pct: 0,
      currentPhase: LOCAL_ACTIVITY_PHASES[0],
    });
  }

  if (hasClosureSignal(trackingState)) {
    return buildProgressShape({
      pct: 80,
      currentPhase: LOCAL_ACTIVITY_PHASES[2],
    });
  }

  if (hasEstablishedExecution(trackingState)) {
    return buildProgressShape({
      pct: 40,
      currentPhase: LOCAL_ACTIVITY_PHASES[1],
    });
  }

  return buildProgressShape({
    pct: 20,
    currentPhase: LOCAL_ACTIVITY_PHASES[0],
  });
}
