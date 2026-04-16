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
