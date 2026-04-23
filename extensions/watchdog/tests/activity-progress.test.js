import test from "node:test";
import assert from "node:assert/strict";

import { CONTRACT_STATUS } from "../lib/core/runtime-status.js";
import { createTrackingState } from "../lib/session-bootstrap.js";
import { deriveTrackingActivityProgress } from "../lib/activity-progress.js";

test("deriveTrackingActivityProgress starts from agent-local zero even when canonical contract stage truth is mid-contract", () => {
  const trackingState = createTrackingState({
    sessionKey: `agent:worker-local-progress:${Date.now()}`,
    agentId: "worker-local-progress",
    parentSession: null,
  });

  trackingState.status = CONTRACT_STATUS.RUNNING;
  trackingState.contract = {
    id: `TC-LOCAL-PROGRESS-${Date.now()}`,
    task: "continue the same contract on another worker",
    assignee: "worker-local-progress",
    status: CONTRACT_STATUS.RUNNING,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    phases: ["分析", "写报告"],
    stagePlan: {
      contractId: "TC-LOCAL-PROGRESS",
      stages: [
        { id: "stage-1", label: "分析", semanticLabel: "分析", status: "completed" },
        { id: "stage-2", label: "写报告", semanticLabel: "写报告", status: "active" },
      ],
      revisionPolicy: { maxRevisions: 2, maxStageDelta: 1 },
    },
    stageRuntime: {
      version: 2,
      currentStageId: "stage-2",
      completedStageIds: ["stage-1"],
      revisionCount: 0,
      lastRevisionReason: null,
    },
  };

  const progress = deriveTrackingActivityProgress(trackingState);

  assert.deepEqual(progress?.phases, ["接手", "执行", "收口"]);
  assert.equal(progress?.currentPhase, "接手");
  assert.equal(progress?.cursor, "0/3");
  assert.equal(progress?.pct, 0);
});

test("deriveTrackingActivityProgress moves to local closure when current session has produced an output artifact", () => {
  const trackingState = createTrackingState({
    sessionKey: `agent:worker-local-progress:closure:${Date.now()}`,
    agentId: "worker-local-progress",
    parentSession: null,
  });

  trackingState.status = CONTRACT_STATUS.RUNNING;
  trackingState.toolCallTotal = 3;
  trackingState.recentToolEvents = [
    { index: 1, tool: "read", kind: "read_local", label: "阅读: task.md", summary: "阅读完成", status: "ok", durationMs: 12, ts: 1 },
    { index: 2, tool: "write", kind: "write_local", label: "写入: result.md", summary: "写入完成", status: "ok", durationMs: 24, ts: 2 },
  ];
  trackingState.activityCursor = {
    source: "framework_tool_event",
    kind: "write_local",
    label: "写入: result.md",
    toolName: "write",
    observedAt: Date.now(),
  };
  trackingState.runtimeObservation = {
    outputArtifact: {
      path: "/tmp/result.md",
      size: 128,
      mtimeMs: Date.now(),
      observedAt: Date.now(),
      headingCount: 1,
      paragraphCount: 2,
      substantiveCharCount: 128,
      scaffoldLineCount: 0,
      isScaffoldOnly: false,
    },
  };

  const progress = deriveTrackingActivityProgress(trackingState);

  assert.equal(progress?.currentPhase, "收口");
  assert.equal(progress?.cursor, "2/3");
  assert.equal(progress?.pct, 80);
});
