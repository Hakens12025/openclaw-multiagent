// loop-epoch-key.js — canonical helper for execution-epoch-scoped loop keys.
//
// Loop state is keyed by execution instance, not mailbox identity. A mailbox
// identity (sessionKey) can be re-used across runs; every run gets its own
// runId. Keying on ${sessionKey}+${runId} prevents failures on run N from
// poisoning run N+1 by mailbox identity reuse.

import { normalizeString } from "../core/normalize.js";

// sessionKeys themselves commonly contain colons (e.g. `agent:worker:main`),
// so we can't round-trip on a simple colon-split. Use a distinctive separator
// so the (sessionKey, runId) pair can be parsed back unambiguously.
export const LOOP_EPOCH_KEY_SEPARATOR = "#run=";

/**
 * Build the canonical epoch-scoped loop key. If runId is missing, fall back
 * to bare sessionKey for call sites that have not been wired yet.
 */
export function buildLoopEpochKey(sessionKey, runId) {
  const session = normalizeString(sessionKey);
  if (!session) return null;
  const run = normalizeString(runId);
  return run ? `${session}${LOOP_EPOCH_KEY_SEPARATOR}${run}` : session;
}

/**
 * Resolve the epoch-scoped loop key from a trackingState snapshot.
 */
export function resolveLoopEpochKey(trackingState) {
  if (!trackingState || typeof trackingState !== "object") return null;
  return buildLoopEpochKey(trackingState.sessionKey, trackingState.runId);
}

/**
 * Parse an epoch-scoped key back into its parts. Returns `{ sessionKey, runId }`
 * where runId may be null if the key was not epoch-scoped.
 */
export function parseLoopEpochKey(epochKey) {
  const key = normalizeString(epochKey);
  if (!key) return null;
  const idx = key.indexOf(LOOP_EPOCH_KEY_SEPARATOR);
  if (idx < 0) {
    return { sessionKey: key, runId: null };
  }
  return {
    sessionKey: key.slice(0, idx),
    runId: key.slice(idx + LOOP_EPOCH_KEY_SEPARATOR.length) || null,
  };
}
