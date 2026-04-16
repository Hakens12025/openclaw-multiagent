// lib/loop-detection.js — Detect repeated identical tool calls within a session
//
// Tracks tool call hashes per session using a sliding window.
// warn at WARN_THRESHOLD (3), hard_stop at STOP_THRESHOLD (5).
// After hard_stop, before_tool_call blocks ALL subsequent tool calls.

import { createHash } from "node:crypto";

const WARN_THRESHOLD = 3;
const STOP_THRESHOLD = 5;
const WINDOW_SIZE = 20;
const MAX_SESSIONS = 100;

// sessionKey → { hashes: Map<hash, count>, hardStopped: boolean, lastAccess: number }
const sessions = new Map();

/**
 * Deterministic hash of a tool call (name + args).
 * Recursive key sort ensures {b:1, a:2} and {a:2, b:1} produce the same hash.
 */
export function hashToolCall(toolName, args) {
  const sorted = JSON.stringify(
    { name: String(toolName || ""), args: args || {} },
    (key, val) => {
      if (val && typeof val === "object" && !Array.isArray(val)) {
        return Object.fromEntries(Object.entries(val).sort(([a], [b]) => a.localeCompare(b)));
      }
      return val;
    },
  );
  return createHash("md5").update(sorted).digest("hex").slice(0, 12);
}

function ensureSession(sessionKey) {
  let s = sessions.get(sessionKey);
  if (!s) {
    // LRU eviction: drop oldest session if at capacity
    if (sessions.size >= MAX_SESSIONS) {
      let oldestKey = null;
      let oldestAccess = Infinity;
      for (const [k, v] of sessions) {
        if (v.lastAccess < oldestAccess) {
          oldestAccess = v.lastAccess;
          oldestKey = k;
        }
      }
      if (oldestKey) sessions.delete(oldestKey);
    }
    s = { hashes: new Map(), hardStopped: false, lastAccess: Date.now() };
    sessions.set(sessionKey, s);
  }
  s.lastAccess = Date.now();
  return s;
}

/**
 * Track a tool call. Returns:
 * - null: no issue
 * - "warn": repeated call detected (count >= WARN_THRESHOLD)
 * - "hard_stop": repeated call threshold exceeded (count >= STOP_THRESHOLD)
 */
export function trackToolCall(sessionKey, toolName, args) {
  if (!sessionKey) return null;
  const s = ensureSession(sessionKey);
  if (s.hardStopped) return "hard_stop";

  const hash = hashToolCall(toolName, args);
  const count = (s.hashes.get(hash) || 0) + 1;
  s.hashes.set(hash, count);

  // Sliding window: trim oldest entries when at capacity
  if (s.hashes.size >= WINDOW_SIZE) {
    const firstKey = s.hashes.keys().next().value;
    s.hashes.delete(firstKey);
  }

  if (count >= STOP_THRESHOLD) {
    s.hardStopped = true;
    return "hard_stop";
  }
  if (count >= WARN_THRESHOLD) {
    return "warn";
  }
  return null;
}

/**
 * Check if a session has been hard-stopped due to loop detection.
 */
export function isSessionHardStopped(sessionKey) {
  if (!sessionKey) return false;
  return sessions.get(sessionKey)?.hardStopped === true;
}

/**
 * Clear loop detection state for a single session.
 */
export function clearSession(sessionKey) {
  if (!sessionKey) return false;
  return sessions.delete(sessionKey);
}

/**
 * Clear all loop detection state. Returns count cleared.
 */
export function clearAllSessions() {
  const count = sessions.size;
  sessions.clear();
  return count;
}

/**
 * Get active session count (for diagnostics).
 */
export function getSessionCount() {
  return sessions.size;
}
