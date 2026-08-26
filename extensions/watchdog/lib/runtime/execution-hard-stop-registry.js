// lib/runtime/execution-hard-stop-registry.js — 执行硬停登记处(L3 沙箱面)
//
// 2026-08-18 自 lib/loop/loop-detection.js 搬入并改名。它与"图回路"零关系:管的是
// 单会话内的执行硬停(重复工具调用/工具预算/产出预算),只是当年与回路共用了 loop
// 一词、住进同一目录,导致 loop 目录约三分之一的对外耦合面其实来自这里。
//
// 状态是模块级 Map 单例,mark 在 after_tool_call、check 在 before_tool_call ——
// 跨 hook 的那一跳由 tests/hard-stop-gate-end-to-end.test.js 守着(ESM 双实例会让
// 拦截静默失效,无异常无日志)。
//
// 原始职责:Detect repeated identical tool calls within a session
//
// Tracks tool call hashes per session using a sliding window.
// warn at WARN_THRESHOLD (3), hard_stop at STOP_THRESHOLD (5).
// After hard_stop, before_tool_call blocks ALL subsequent tool calls.

import { createHash } from "node:crypto";

// 拦截理由的协议前缀:agent 面可见,且被 tool-timeline 与 delivery 读面按正则消费。
// 单一真值放在闸的所有者这里 —— 此前是三处裸字符串各写一份,改一处另两处静默漂移。
// 2026-08-19 由 "[LOOP DETECTED]" 改名:这是执行硬停(重复工具调用/预算耗尽),与图回路
// 零关系;回路机制已退役,loop 一词不再承担任何功能。
export const HARD_STOP_BLOCK_TAG = "[EXECUTION HALTED]";
export const HARD_STOP_BLOCK_REASON = `${HARD_STOP_BLOCK_TAG} runtime 已完成本轮工具阶段;请用普通文本给出最终结果。`;

export const HARD_STOP_REASON = Object.freeze({
  REPEAT_THRESHOLD: "repeat_threshold",
  MAX_TOOL_CALLS: "max_tool_calls",
  // FIX(A4-output-length-stop): unbounded cumulative tool-output volume had no hard-stop reason -> add one so it terminalizes FAILED like the other budgets.
  OUTPUT_BUDGET_EXHAUSTED: "output_budget_exhausted",
  MANUAL: "manual",
  // 兜底值:登记处查不到理由时用它。此前叫 LOOP_DETECTED,但它零生产者、
  // buildHardStopSummary 也没有它的条目 —— 日志里的 reason=loop_detected 真实含义
  // 一直是"原因查表落空",名字在说谎(2026-08-19 收官审计 D 类)。
  UNSPECIFIED: "unspecified",
});

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
    s = {
      hashes: new Map(),
      hardStopped: false,
      hardStopReason: null,
      lastAccess: Date.now(),
    };
    sessions.set(sessionKey, s);
  }
  s.lastAccess = Date.now();
  return s;
}

export function markSessionHardStopped(epochKey, reason) {
  if (!epochKey) return false;
  const s = ensureSession(epochKey);
  s.hardStopped = true;
  s.hardStopReason = typeof reason === "string" && reason ? reason : s.hardStopReason || "hard_stop";
  return true;
}

/**
 * Read the reason for hard-stop on a session, or null if none.
 */
export function getSessionHardStopReason(epochKey) {
  if (!epochKey) return null;
  return sessions.get(epochKey)?.hardStopReason || null;
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
  // Delete before re-inserting to refresh insertion order (Map preserves insertion order;
  // updating an existing key in-place does NOT move it to the end, so without this delete
  // a high-frequency hash would remain the "oldest" entry and get evicted before reaching
  // STOP_THRESHOLD when a new distinct hash enters a full window).
  s.hashes.delete(hash);
  s.hashes.set(hash, count);

  // Sliding window: trim oldest entry when window overflows.
  // Use > WINDOW_SIZE (not >=): after delete+set, existing keys keep the same size,
  // only a brand-new distinct key grows the map beyond capacity.
  if (s.hashes.size > WINDOW_SIZE) {
    const firstKey = s.hashes.keys().next().value;
    s.hashes.delete(firstKey);
  }

  if (count >= STOP_THRESHOLD) {
    markSessionHardStopped(sessionKey, HARD_STOP_REASON.REPEAT_THRESHOLD);
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
