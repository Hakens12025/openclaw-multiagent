// Tests: agent-end-lifecycle.js runAgentEndLifecycle dedup map race condition
// Bug: runPromise created (IIFE starts) before being stored in activeAgentEndRuns,
//      so concurrent calls both pass the existingRun check and double-run the lifecycle.
// Fix: register a deferred placeholder in the map BEFORE the IIFE body executes,
//      so any concurrent synchronous call immediately sees an entry.

import test from "node:test";
import assert from "node:assert/strict";

import { runAgentEndLifecycle } from "../lib/lifecycle/agent-end-lifecycle.js";

const logger = {
  info() {},
  warn() {},
  error() {},
};

function makeMinimalEvent(success = true) {
  return { success, error: null, synthetic: false };
}

function makeCtx(agentId, sessionKey) {
  return { agentId, sessionKey };
}

function makeApi() {
  return {
    on() {},
    emit() {},
    sessions: { get() { return null; } },
  };
}

test("concurrent calls with the same sessionKey return same resolved value (lifecycle runs once)", async () => {
  const sessionKey = `agent:dedup-test-${Date.now()}:contract:TC-dedup`;
  const agentId = "dedup-test-agent";
  const event = makeMinimalEvent(true);
  const ctx = makeCtx(agentId, sessionKey);
  const api = makeApi();

  // Fire two calls simultaneously without any await between them
  const p1 = runAgentEndLifecycle({ event, ctx, api, logger, trackingState: null });
  const p2 = runAgentEndLifecycle({ event, ctx, api, logger, trackingState: null });

  const [r1, r2] = await Promise.all([p1, p2]);

  // Both must resolve to the SAME lifecycle context object — proof that the lifecycle ran only once
  assert.strictEqual(r1, r2, "concurrent calls must resolve to the same lifecycleContext (lifecycle ran once, not twice)");
});

test("sequential calls with the same sessionKey create independent runs", async () => {
  const sessionKey = `agent:dedup-seq-${Date.now()}:contract:TC-dedup-seq`;
  const agentId = "dedup-seq-agent";
  const event = makeMinimalEvent(true);
  const ctx = makeCtx(agentId, sessionKey);
  const api = makeApi();

  const r1 = await runAgentEndLifecycle({ event, ctx, api, logger, trackingState: null });
  const r2 = await runAgentEndLifecycle({ event, ctx, api, logger, trackingState: null });

  // Sequential calls should each produce their own context (the dedup map was cleared after r1 finished)
  assert.notStrictEqual(r1, r2, "sequential calls should produce independent lifecycle contexts");
  assert.ok(r1 !== undefined, "first sequential call should return a lifecycle context");
  assert.ok(r2 !== undefined, "second sequential call should return a lifecycle context");
});

test("after first run completes, new concurrent pair also deduplicates to one run", async () => {
  const sessionKey = `agent:dedup-cleanup-${Date.now()}:contract:TC-dedup-cleanup`;
  const agentId = "dedup-cleanup-agent";
  const ctx = makeCtx(agentId, sessionKey);
  const api = makeApi();

  // First run completes
  await runAgentEndLifecycle({ event: makeMinimalEvent(true), ctx, api, logger, trackingState: null });

  // New concurrent pair after map is cleared
  const p3 = runAgentEndLifecycle({ event: makeMinimalEvent(true), ctx, api, logger, trackingState: null });
  const p4 = runAgentEndLifecycle({ event: makeMinimalEvent(true), ctx, api, logger, trackingState: null });

  const [r3, r4] = await Promise.all([p3, p4]);
  assert.strictEqual(r3, r4, "second concurrent pair should also deduplicate to a single lifecycle context");
});
