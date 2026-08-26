import { SYSTEM_ACTION_DELIVERY_IDS } from "./delivery/delivery-protocols.js";

const SYSTEM_ACTION_DELIVERY_SOURCE_IDS = new Set([
  SYSTEM_ACTION_DELIVERY_IDS.ASSIGN_TASK_RESULT,
  SYSTEM_ACTION_DELIVERY_IDS.RUNTIME_RESULT,
]);

function normalizeString(value) {
  return typeof value === "string" ? value.trim() : "";
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

  // 回路运行时退役(2026-08-18):此处曾有第二腿 kind==="loop_start"(唯一生产者是
  // loop-round-runtime 的开轮派工),给 system→回路起点 一条绕开图边授权的旁路。
  // 面消失后旁路只剩 system_action_delivery 一腿——任何其它 kind 一律不授权。
  return false;
}
