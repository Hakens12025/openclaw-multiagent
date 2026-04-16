import test from "node:test";
import assert from "node:assert/strict";

import {
  hashToolCall,
  trackToolCall,
  isSessionHardStopped,
  clearSession,
  clearAllSessions,
  getSessionCount,
} from "../lib/loop/loop-detection.js";

// --- hashToolCall ---

test("hashToolCall: same args with different key order produce same hash", () => {
  const h1 = hashToolCall("read", { file_path: "/tmp/a.txt", limit: 10 });
  const h2 = hashToolCall("read", { limit: 10, file_path: "/tmp/a.txt" });
  assert.equal(h1, h2);
});

test("hashToolCall: different args produce different hash", () => {
  const h1 = hashToolCall("read", { file_path: "/tmp/a.txt" });
  const h2 = hashToolCall("read", { file_path: "/tmp/b.txt" });
  assert.notEqual(h1, h2);
});

test("hashToolCall: different tool names produce different hash", () => {
  const h1 = hashToolCall("read", { path: "/tmp/a.txt" });
  const h2 = hashToolCall("write", { path: "/tmp/a.txt" });
  assert.notEqual(h1, h2);
});

test("hashToolCall: nested objects are sorted recursively", () => {
  const h1 = hashToolCall("call", { outer: { b: 2, a: 1 } });
  const h2 = hashToolCall("call", { outer: { a: 1, b: 2 } });
  assert.equal(h1, h2);
});

test("hashToolCall: null/undefined args handled gracefully", () => {
  const h1 = hashToolCall("read", null);
  const h2 = hashToolCall("read", undefined);
  assert.equal(h1, h2);
});

// --- trackToolCall ---

test("trackToolCall: first 2 calls return null (no issue)", () => {
  clearAllSessions();
  const sk = `test-track-${Date.now()}`;
  assert.equal(trackToolCall(sk, "read", { path: "/a" }), null);
  assert.equal(trackToolCall(sk, "read", { path: "/a" }), null);
});

test("trackToolCall: 3rd identical call returns warn", () => {
  clearAllSessions();
  const sk = `test-warn-${Date.now()}`;
  trackToolCall(sk, "read", { path: "/a" });
  trackToolCall(sk, "read", { path: "/a" });
  assert.equal(trackToolCall(sk, "read", { path: "/a" }), "warn");
});

test("trackToolCall: 4th call still returns warn (not blocked)", () => {
  clearAllSessions();
  const sk = `test-warn4-${Date.now()}`;
  for (let i = 0; i < 3; i++) trackToolCall(sk, "read", { path: "/a" });
  assert.equal(trackToolCall(sk, "read", { path: "/a" }), "warn");
});

test("trackToolCall: 5th identical call returns hard_stop", () => {
  clearAllSessions();
  const sk = `test-stop-${Date.now()}`;
  for (let i = 0; i < 4; i++) trackToolCall(sk, "read", { path: "/a" });
  assert.equal(trackToolCall(sk, "read", { path: "/a" }), "hard_stop");
});

test("trackToolCall: after hard_stop, any call returns hard_stop", () => {
  clearAllSessions();
  const sk = `test-post-stop-${Date.now()}`;
  for (let i = 0; i < 5; i++) trackToolCall(sk, "read", { path: "/a" });
  // Even a different tool call returns hard_stop
  assert.equal(trackToolCall(sk, "write", { path: "/b" }), "hard_stop");
});

test("trackToolCall: different tools don't trigger warning", () => {
  clearAllSessions();
  const sk = `test-diff-${Date.now()}`;
  assert.equal(trackToolCall(sk, "read", { path: "/a" }), null);
  assert.equal(trackToolCall(sk, "write", { path: "/b" }), null);
  assert.equal(trackToolCall(sk, "edit", { path: "/c" }), null);
});

// --- isSessionHardStopped ---

test("isSessionHardStopped: true after hard_stop", () => {
  clearAllSessions();
  const sk = `test-hs-${Date.now()}`;
  for (let i = 0; i < 5; i++) trackToolCall(sk, "read", { path: "/x" });
  assert.equal(isSessionHardStopped(sk), true);
});

test("isSessionHardStopped: false for normal session", () => {
  clearAllSessions();
  const sk = `test-normal-${Date.now()}`;
  trackToolCall(sk, "read", { path: "/x" });
  assert.equal(isSessionHardStopped(sk), false);
});

test("isSessionHardStopped: false for unknown session", () => {
  assert.equal(isSessionHardStopped("nonexistent-session"), false);
});

// --- clearSession + clearAllSessions ---

test("clearSession: resets hard_stop state", () => {
  clearAllSessions();
  const sk = `test-clear-${Date.now()}`;
  for (let i = 0; i < 5; i++) trackToolCall(sk, "read", { path: "/x" });
  assert.equal(isSessionHardStopped(sk), true);
  clearSession(sk);
  assert.equal(isSessionHardStopped(sk), false);
  // Can track again fresh
  assert.equal(trackToolCall(sk, "read", { path: "/x" }), null);
});

test("clearAllSessions: clears everything", () => {
  clearAllSessions();
  trackToolCall("s1", "read", {});
  trackToolCall("s2", "read", {});
  assert.equal(getSessionCount(), 2);
  clearAllSessions();
  assert.equal(getSessionCount(), 0);
});

// --- LRU eviction ---

test("LRU eviction: oldest session evicted when exceeding 100", () => {
  clearAllSessions();
  // Create 100 sessions
  for (let i = 0; i < 100; i++) {
    trackToolCall(`lru-${i}`, "read", { n: i });
  }
  assert.equal(getSessionCount(), 100);
  // 101st session should evict the first one
  trackToolCall("lru-100", "read", { n: 100 });
  assert.equal(getSessionCount(), 100);
  // lru-0 should have been evicted (its state is gone)
  assert.equal(isSessionHardStopped("lru-0"), false);
});

// --- Hook cascade simulation ---

test("hook cascade: trackToolCall 5x → isSessionHardStopped true", () => {
  clearAllSessions();
  const sk = `cascade-${Date.now()}`;
  // Simulate after_tool_call tracking
  for (let i = 0; i < 5; i++) {
    trackToolCall(sk, "read", { file_path: "/same/path" });
  }
  // Simulate before_tool_call check
  assert.equal(isSessionHardStopped(sk), true);
});

test("hook cascade: clearSession → isSessionHardStopped false", () => {
  clearAllSessions();
  const sk = `cascade-clear-${Date.now()}`;
  for (let i = 0; i < 5; i++) {
    trackToolCall(sk, "read", { file_path: "/same/path" });
  }
  assert.equal(isSessionHardStopped(sk), true);
  clearSession(sk);
  assert.equal(isSessionHardStopped(sk), false);
});
