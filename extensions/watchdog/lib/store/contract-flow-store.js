// contract-flow-store.js — Unified store for dispatch-related state:
//   1. Dispatch chain origins    (targetAgentId → origin)

import {
  dispatchChain,
} from "../state-collections.js";
import { persistState } from "../state-persistence.js";

// ─── normalizers ────────────────────────────────────────────────────

function normalizeTargetAgentId(agentId) {
  return typeof agentId === "string" && agentId.trim() ? agentId.trim() : null;
}

function normalizeDispatchChainOrigin(origin) {
  if (!origin || typeof origin !== "object") return null;
  const originAgentId = normalizeTargetAgentId(origin.originAgentId);
  const originSessionKey = typeof origin.originSessionKey === "string" && origin.originSessionKey.trim()
    ? origin.originSessionKey.trim()
    : null;
  if (!originAgentId || !originSessionKey) {
    return null;
  }
  return {
    originAgentId,
    originSessionKey,
    ts: Number.isFinite(origin.ts) ? origin.ts : Date.now(),
  };
}

// ─── 1. Dispatch chain origins ──────────────────────────────────────

export function getDispatchChainSize() {
  return dispatchChain.size;
}

export function snapshotDispatchChain() {
  return Object.fromEntries(dispatchChain);
}

export function restoreDispatchChainSnapshot(savedSnapshot, logger = null) {
  if (!savedSnapshot || typeof savedSnapshot !== "object") {
    return 0;
  }

  let restored = 0;
  for (const [targetAgentId, origin] of Object.entries(savedSnapshot)) {
    const normalizedTarget = normalizeTargetAgentId(targetAgentId);
    const normalizedOrigin = normalizeDispatchChainOrigin(origin);
    if (!normalizedTarget || !normalizedOrigin) {
      continue;
    }
    dispatchChain.set(normalizedTarget, normalizedOrigin);
    restored += 1;
  }

  if (restored > 0) {
    logger?.info?.(`[watchdog] restored ${dispatchChain.size} dispatch chain entries from disk`);
  }
  return restored;
}

export async function rememberDispatchChainOrigin(targetAgentId, origin, {
  logger = null,
  persist = true,
} = {}) {
  const normalizedTarget = normalizeTargetAgentId(targetAgentId);
  const normalizedOrigin = normalizeDispatchChainOrigin(origin);
  if (!normalizedTarget || !normalizedOrigin) {
    return null;
  }

  dispatchChain.set(normalizedTarget, normalizedOrigin);
  if (persist) {
    await persistState(logger);
  }
  return normalizedOrigin;
}

export async function rememberDispatchChainOrigins(targetAgentIds, origin, {
  logger = null,
  persist = true,
} = {}) {
  const normalizedOrigin = normalizeDispatchChainOrigin(origin);
  if (!normalizedOrigin) {
    return 0;
  }

  const targets = [...new Set((Array.isArray(targetAgentIds) ? targetAgentIds : [])
    .map(normalizeTargetAgentId)
    .filter(Boolean))];
  if (targets.length === 0) {
    return 0;
  }

  for (const targetAgentId of targets) {
    dispatchChain.set(targetAgentId, normalizedOrigin);
  }
  if (persist) {
    await persistState(logger);
  }
  return targets.length;
}

export async function pruneDispatchChainOrigins(maxAgeMs, {
  logger = null,
  persist = true,
  now = Date.now(),
} = {}) {
  const ttlMs = Math.max(0, Number(maxAgeMs) || 0);
  let removed = 0;
  for (const [targetAgentId, origin] of dispatchChain.entries()) {
    if (!origin || !Number.isFinite(origin.ts) || (now - origin.ts) <= ttlMs) {
      continue;
    }
    dispatchChain.delete(targetAgentId);
    removed++;
  }
  if (persist && removed > 0) {
    await persistState(logger);
  }
  return removed;
}

export async function clearDispatchChainStore({
  logger = null,
  persist = true,
} = {}) {
  const count = dispatchChain.size;
  dispatchChain.clear();
  if (persist && count > 0) {
    await persistState(logger);
  }
  return count;
}
