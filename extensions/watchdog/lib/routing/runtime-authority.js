import { SYSTEM_ACTION_DELIVERY_IDS } from "./delivery-protocols.js";

const SYSTEM_ACTION_DELIVERY_SOURCE_IDS = new Set([
  SYSTEM_ACTION_DELIVERY_IDS.ASSIGN_TASK_RESULT,
  SYSTEM_ACTION_DELIVERY_IDS.REVIEW_VERDICT,
  SYSTEM_ACTION_DELIVERY_IDS.RUNTIME_RESULT,
]);

function normalizeString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function listIncludesString(values, target) {
  if (!Array.isArray(values)) return false;
  return values.some((value) => normalizeString(value) === target);
}

function authorityMatchesTarget(runtimeAuthority, target) {
  const authorityTarget = normalizeString(runtimeAuthority.targetAgent);
  if (authorityTarget) {
    return authorityTarget === target;
  }
  return false;
}

export function hasRuntimeGraphBypassAuthority({
  fromAgent = null,
  targetAgent = null,
  runtimeAuthority = null,
} = {}) {
  if (!runtimeAuthority || typeof runtimeAuthority !== "object") {
    return false;
  }

  const from = normalizeString(fromAgent);
  const target = normalizeString(targetAgent);

  if (
    runtimeAuthority.kind === "system_action_delivery"
    && SYSTEM_ACTION_DELIVERY_SOURCE_IDS.has(from)
    && runtimeAuthority.deliveryId === from
    && authorityMatchesTarget(runtimeAuthority, target)
  ) {
    return true;
  }

  if (runtimeAuthority.kind !== "loop_start") {
    return false;
  }

  const loopId = normalizeString(runtimeAuthority.loopId);
  const startAgent = normalizeString(runtimeAuthority.startAgent);
  if (from !== "system" || !loopId || !target || startAgent !== target) {
    return false;
  }

  return listIncludesString(runtimeAuthority.nodes, target);
}
