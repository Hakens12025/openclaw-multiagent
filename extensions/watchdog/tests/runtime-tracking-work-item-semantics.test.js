import test from "node:test";
import assert from "node:assert/strict";

import { buildRuntimeSummary } from "../lib/operator/operator-snapshot-runtime.js";
import { dispatchTargetStateMap } from "../lib/state.js";
import {
  clearTrackingStore,
  rememberTrackingState,
  snapshotTrackingSessions,
} from "../lib/store/tracker-store.js";

test.afterEach(() => {
  clearTrackingStore();
  dispatchTargetStateMap.clear();
});

test("snapshotTrackingSessions preserves unknown pct instead of coercing it to 0", () => {
  const now = Date.now();
  const sessionKey = "agent:worker:unknown-progress";

  rememberTrackingState(sessionKey, {
    sessionKey,
    agentId: "worker",
    status: "running",
    startMs: now - 2000,
    toolCallTotal: 1,
    lastLabel: "处理中",
    pct: null,
    contract: {
      id: "TC-UNKNOWN-PROGRESS",
      task: "unknown progress should stay unknown",
      status: "running",
    },
  });

  const sessions = snapshotTrackingSessions(now);
  const summary = buildRuntimeSummary(10);
  const snapshot = sessions[sessionKey];
  const runtimeEntry = summary.tracking.sessions.find((entry) => entry?.sessionKey === sessionKey);

  assert.equal(snapshot?.pct ?? null, null);
  assert.equal(runtimeEntry?.pct ?? null, null);
});

test("buildRuntimeSummary derives worker counts from canonical dispatch targets snapshot", () => {
  dispatchTargetStateMap.clear();
  dispatchTargetStateMap.set("planner-a", {
    busy: false,
    healthy: true,
    dispatching: false,
    currentContract: null,
    lastSeen: Date.now(),
    queue: [{ contractId: "TC-Q-1" }],
  });
  dispatchTargetStateMap.set("worker-a", {
    busy: true,
    healthy: true,
    dispatching: false,
    currentContract: "TC-ACTIVE",
    lastSeen: Date.now(),
    queue: [],
  });
  dispatchTargetStateMap.set("worker-b", {
    busy: false,
    healthy: false,
    dispatching: true,
    currentContract: "TC-DISPATCH",
    lastSeen: Date.now(),
    queue: [],
  });

  const summary = buildRuntimeSummary(10);

  assert.equal(summary.queueDepth, 1);
  assert.equal("workers" in summary, false);
  assert.equal(summary.targets.total, 3);
  assert.equal(summary.targets.busy, 1);
  assert.equal(summary.targets.idle, 2);
  assert.equal(summary.targets.unhealthy, 1);
  assert.equal(summary.targets.dispatching, 1);
  assert.equal(summary.targets.queued, 1);
  assert.equal(summary.queueDiagnostics.issueCount, 1);
  assert.equal(summary.queueDiagnostics.issues[0]?.code, "idle_target_with_pending_queue");
  assert.deepEqual(
    summary.targets.targets.map((entry) => entry.agentId),
    ["planner-a", "worker-a", "worker-b"],
  );
});

test("buildRuntimeSummary exposes queue split-brain diagnostics for unbound running trackers", () => {
  const sessionKey = "agent:planner:contract:tc-unclaimed";

  rememberTrackingState(sessionKey, {
    sessionKey,
    agentId: "planner",
    status: "running",
    startMs: Date.now() - 120000,
    toolCallTotal: 4,
    lastLabel: "阅读: contract.json",
    contract: null,
  });
  dispatchTargetStateMap.set("planner", {
    busy: false,
    healthy: true,
    dispatching: false,
    currentContract: null,
    lastSeen: Date.now(),
    queue: [{ contractId: "TC-UNCLAIMED", fromAgent: "controller" }],
  });

  const summary = buildRuntimeSummary(10);

  assert.equal(summary.tracking.runningWithoutContract, 1);
  assert.equal(summary.queueDiagnostics.hasSplitBrain, true);
  assert.equal(summary.queueDiagnostics.issueCount, 2);
  assert.equal(
    typeof summary.queueDiagnostics.issues.find((issue) => issue.code === "idle_target_with_pending_queue")?.nextContractId,
    "string",
  );
  assert.deepEqual(
    summary.queueDiagnostics.issues.map((issue) => issue.code).sort(),
    ["idle_target_with_pending_queue", "running_tracking_without_contract"],
  );
});

test("buildRuntimeSummary excludes hidden control-plane sessions from queue split-brain diagnostics", () => {
  const sessionKey = "agent:operator:main";

  rememberTrackingState(sessionKey, {
    sessionKey,
    agentId: "operator",
    status: "running",
    startMs: Date.now() - 60000,
    toolCallTotal: 1,
    lastLabel: "operator control-plane inspection",
    contract: null,
  });

  const summary = buildRuntimeSummary(10);
  const operatorEntry = summary.tracking.sessions.find((entry) => entry.sessionKey === sessionKey);

  assert.equal(operatorEntry?.plane, "control_plane");
  assert.equal(operatorEntry?.mainViewVisible, false);
  assert.equal(operatorEntry?.formalTimelineVisible, false);
  assert.equal(summary.tracking.runningWithoutContract, 0);
  assert.equal(summary.queueDiagnostics.issueCount, 0);
  assert.equal(summary.queueDiagnostics.hasSplitBrain, false);
});
