// lib/runtime/session-epoch-key.js — 执行代号键(L0 运行时面)
//
// 2026-08-18 自 lib/loop/loop-epoch-key.js 搬入并改名。它在 import 图上是通用机制,
// 但携带一条【回路专属不变量】,搬迁时随本注释一并带走(全库唯一写下来的记录):
//   整个 loop session 共用一个 lineage runId,故 epoch 必须比 lineage run 更细 ——
//   合并两者会让 loop 全程同 epoch、硬停标记跨轮逃逸(2026-08-14 批①对抗审查抓获)。
//   对应记录另见 lib/contract/contract-lineage.js 的 runId 段。
//
// 原始说明:canonical helper for execution-epoch-scoped keys.
//
// Loop state is keyed by execution instance, not mailbox identity. A mailbox
// identity (sessionKey) can be re-used across runs; every run gets its own
// runId. Keying on ${sessionKey}+${runId} prevents failures on run N from
// poisoning run N+1 by mailbox identity reuse.

import { normalizeString } from "../core/normalize.js";

// sessionKeys themselves commonly contain colons (e.g. `agent:worker:main`),
// so we can't round-trip on a simple colon-split. Use a distinctive separator
// so the (sessionKey, runId) pair can be parsed back unambiguously.
export const SESSION_EPOCH_KEY_SEPARATOR = "#run=";

/**
 * Build the canonical epoch-scoped loop key. If runId is missing, fall back
 * to bare sessionKey for call sites that have not been wired yet.
 */
export function buildSessionEpochKey(sessionKey, runId) {
  const session = normalizeString(sessionKey);
  if (!session) return null;
  const run = normalizeString(runId);
  return run ? `${session}${SESSION_EPOCH_KEY_SEPARATOR}${run}` : session;
}

/**
 * Resolve the epoch-scoped loop key from a trackingState snapshot.
 */
export function resolveSessionEpochKey(trackingState) {
  if (!trackingState || typeof trackingState !== "object") return null;
  return buildSessionEpochKey(trackingState.sessionKey, trackingState.runId);
}

/**
 * Parse an epoch-scoped key back into its parts. Returns `{ sessionKey, runId }`
 * where runId may be null if the key was not epoch-scoped.
 */
export function parseSessionEpochKey(epochKey) {
  const key = normalizeString(epochKey);
  if (!key) return null;
  const idx = key.indexOf(SESSION_EPOCH_KEY_SEPARATOR);
  if (idx < 0) {
    return { sessionKey: key, runId: null };
  }
  return {
    sessionKey: key.slice(0, idx),
    runId: key.slice(idx + SESSION_EPOCH_KEY_SEPARATOR.length) || null,
  };
}
