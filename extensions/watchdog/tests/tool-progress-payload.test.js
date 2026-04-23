import test from "node:test";
import assert from "node:assert/strict";

import { buildProgressPayload } from "../lib/transport/sse.js";
import { CONTRACT_STATUS } from "../lib/core/runtime-status.js";

test("buildProgressPayload exposes recent structured tool events", () => {
  const trackingState = {
    sessionKey: `agent:worker-tool-events:${Date.now()}`,
    agentId: "worker-tool-events",
    parentSession: null,
    startMs: Date.now() - 50,
    toolCalls: [],
    recentToolEvents: [
      {
        index: 3,
        tool: "write",
        kind: "write_local",
        label: "写入: result.md",
        summary: "写入完成 (42ms): result.md",
        status: "ok",
        durationMs: 42,
        runId: "run-tool-events",
        toolCallId: "call-tool-events",
        ts: 123,
      },
    ],
    toolCallTotal: 3,
    lastLabel: "写入: result.md",
    status: CONTRACT_STATUS.RUNNING,
    contract: null,
    artifactContext: null,
    activityCursor: null,
    runtimeObservation: null,
    stageProjection: null,
    cursor: "0/0",
    pct: 0,
    estimatedPhase: "",
  };

  const payload = buildProgressPayload(trackingState);

  assert.deepEqual(payload.recentToolEvents, [
    {
      index: 3,
      tool: "write",
      kind: "write_local",
      label: "写入: result.md",
      summary: "写入完成 (42ms): result.md",
      status: "ok",
      durationMs: 42,
      runId: "run-tool-events",
      toolCallId: "call-tool-events",
      ts: 123,
    },
  ]);
});

test("buildProgressPayload exposes agent-local activity progress while preserving canonical contract stage truth", () => {
  const trackingState = {
    sessionKey: `agent:worker-tool-events:local-progress:${Date.now()}`,
    agentId: "worker-tool-events",
    parentSession: null,
    startMs: Date.now() - 50,
    toolCalls: [],
    recentToolEvents: [],
    toolCallTotal: 0,
    lastLabel: "启动中",
    status: CONTRACT_STATUS.RUNNING,
    contract: {
      id: `TC-LOCAL-PAYLOAD-${Date.now()}`,
      task: "handoff should reset visible progress",
      assignee: "worker-tool-events",
      status: CONTRACT_STATUS.RUNNING,
      createdAt: Date.now() - 50,
      updatedAt: Date.now(),
      phases: ["分析", "写报告"],
      stagePlan: {
        contractId: "TC-LOCAL-PAYLOAD",
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
    },
    artifactContext: null,
    activityCursor: null,
    runtimeObservation: null,
    stageProjection: null,
    cursor: "0/0",
    pct: 0,
    estimatedPhase: "",
  };

  const payload = buildProgressPayload(trackingState);

  assert.deepEqual(payload.activityProgress?.phases, ["接手", "执行", "收口"]);
  assert.equal(payload.activityProgress?.currentPhase, "接手");
  assert.equal(payload.cursor, "0/3");
  assert.equal(payload.pct, 0);
  assert.equal(payload.estimatedPhase, "接手");
  assert.equal(payload.stageRuntime?.currentStageId, "stage-2");
  assert.deepEqual(payload.phases, ["分析", "写报告"]);
});
