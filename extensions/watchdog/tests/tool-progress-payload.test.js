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

test("buildProgressPayload exposes unified ioObservation", () => {
  const ioObservation = {
    version: 1,
    input: {
      contractId: "TC-TOOL-PAYLOAD-IO",
      task: "inspect agent input/output payload",
      effectiveTools: ["read", "write", "edit"],
    },
    output: {
      primaryOutputPath: "/tmp/tool-progress-io.md",
      artifactPaths: ["/tmp/tool-progress-io.md"],
      textPreview: "worker output preview",
    },
  };
  const trackingState = {
    sessionKey: `agent:worker-tool-io:${Date.now()}`,
    agentId: "worker-tool-io",
    parentSession: null,
    startMs: Date.now() - 50,
    toolCalls: [],
    recentToolEvents: [],
    toolCallTotal: 0,
    lastLabel: "启动中",
    status: CONTRACT_STATUS.RUNNING,
    contract: {
      id: "TC-TOOL-PAYLOAD-IO",
      task: "inspect agent input/output payload",
      assignee: "worker-tool-io",
      status: "running",
    },
    artifactContext: null,
    activityCursor: null,
    runtimeObservation: null,
    ioObservation,
    stageProjection: null,
    cursor: "0/0",
    pct: 0,
    estimatedPhase: "",
  };

  const payload = buildProgressPayload(trackingState);

  assert.deepEqual(payload.ioObservation, ioObservation);
});
