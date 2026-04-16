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

test("snapshotTrackingSessions exposes canonical work item identity for artifact-backed sessions", () => {
  const now = Date.now();
  const sessionKey = "agent:reviewer:artifact-session";

  rememberTrackingState(sessionKey, {
    sessionKey,
    agentId: "reviewer",
    status: "running",
    startMs: now - 5000,
    toolCallTotal: 2,
    lastLabel: "审查中",
    artifactContext: {
      kind: "code_review",
      request: {
        instruction: "检查当前实现是否满足 stage runtime 语义",
        requestedAt: now - 6000,
      },
      protocol: {
        transport: "code_review.json",
        intentType: "request_review",
      },
    },
  });

  const sessions = snapshotTrackingSessions(now);
  const entry = sessions[sessionKey];

  assert.equal(entry?.hasContract, false);
  assert.equal(entry?.workItemId, "artifact:code_review:agent:reviewer:artifact-session");
  assert.equal(entry?.workItemKind, "artifact_backed");
  assert.equal(entry?.taskType, "request_review");
});

test("buildRuntimeSummary tracking sessions retain canonical work item identity", () => {
  const now = Date.now();
  const sessionKey = "agent:reviewer:artifact-runtime-summary";

  rememberTrackingState(sessionKey, {
    sessionKey,
    agentId: "reviewer",
    status: "running",
    startMs: now - 4000,
    artifactContext: {
      kind: "code_review",
      request: {
        instruction: "检查当前实现是否满足 runtime summary 语义",
        requestedAt: now - 4500,
      },
      protocol: {
        transport: "code_review.json",
        intentType: "request_review",
      },
    },
  });

  const summary = buildRuntimeSummary(10);
  const entry = summary.tracking.sessions.find((item) => item?.sessionKey === sessionKey);

  assert.equal(entry?.hasContract, false);
  assert.equal(entry?.workItemId, "artifact:code_review:agent:reviewer:artifact-runtime-summary");
  assert.equal(entry?.workItemKind, "artifact_backed");
  assert.equal(entry?.taskType, "request_review");
  assert.equal("pendingPlannerDispatches" in summary, false);
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
    roundRobinCursor: 0,
  });
  dispatchTargetStateMap.set("worker-a", {
    busy: true,
    healthy: true,
    dispatching: false,
    currentContract: "TC-ACTIVE",
    lastSeen: Date.now(),
    queue: [],
    roundRobinCursor: 0,
  });
  dispatchTargetStateMap.set("worker-b", {
    busy: false,
    healthy: false,
    dispatching: true,
    currentContract: "TC-DISPATCH",
    lastSeen: Date.now(),
    queue: [],
    roundRobinCursor: 0,
  });

  const summary = buildRuntimeSummary(10);

  assert.equal(summary.queueDepth, 1);
  assert.equal("workers" in summary, false);
  assert.equal(summary.targets.total, 3);
  assert.equal(summary.targets.busy, 1);
  assert.equal(summary.targets.idle, 2);
  assert.equal(summary.targets.unhealthy, 1);
  assert.equal(summary.targets.dispatching, 1);
  assert.deepEqual(
    summary.targets.targets.map((entry) => entry.agentId),
    ["planner-a", "worker-a", "worker-b"],
  );
});
