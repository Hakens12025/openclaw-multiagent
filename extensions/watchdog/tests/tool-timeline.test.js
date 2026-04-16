import test from "node:test";
import assert from "node:assert/strict";

import { buildToolTimelineEvent } from "../lib/tool-timeline.js";

test("buildToolTimelineEvent summarizes runtime-observed exec completion", () => {
  const event = buildToolTimelineEvent({
    index: 1,
    toolName: "exec",
    params: {
      command: "npm test -- --runInBand",
    },
    durationMs: 1200,
    result: {
      exitCode: 0,
      stdout: "all good",
    },
    runId: "run-tool-timeline",
    toolCallId: "call-tool-timeline",
    observedAt: 123,
  });

  assert.deepEqual(event, {
    index: 1,
    tool: "exec",
    kind: "exec",
    label: "执行: npm test -- --runInBand",
    summary: "执行完成 (1.2s): npm test -- --runInBand",
    status: "ok",
    durationMs: 1200,
    runId: "run-tool-timeline",
    toolCallId: "call-tool-timeline",
    ts: 123,
  });
});
