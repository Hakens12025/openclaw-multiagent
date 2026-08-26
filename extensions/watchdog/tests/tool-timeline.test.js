import test from "node:test";
import assert from "node:assert/strict";

import {
  appendToolTimelineEvent,
  buildToolTimelineEvent,
} from "../lib/tool-timeline.js";

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

test("buildToolTimelineEvent classifies path guard write failures", () => {
  const event = buildToolTimelineEvent({
    index: 2,
    toolName: "Write",
    params: {
      path: "/tmp/output",
    },
    error: {
      message: "EISDIR: illegal operation on a directory, open '/tmp/output'",
    },
    observedAt: 456,
  });

  assert.equal(event.status, "error");
  assert.equal(event.errorClass, "model_tool_args_invalid");
  assert.equal(event.errorMessage, "EISDIR: illegal operation on a directory, open '/tmp/output'");
  assert.equal(event.summary, "写入失败: output");
});

test("buildToolTimelineEvent classifies execution hard-stop blocks", () => {
  const event = buildToolTimelineEvent({
    index: 3,
    toolName: "Write",
    params: {
      path: "outbox/runtime_result.json",
    },
    error: "[EXECUTION HALTED] runtime 已完成本轮工具阶段;请用普通文本给出最终结果。",
    observedAt: 789,
  });

  assert.equal(event.status, "error");
  assert.equal(event.errorClass, "loop_hard_stop_block");
  assert.match(event.summary, /写入失败/u);
});

test("appendToolTimelineEvent collapses repeated execution hard-stop blocks", () => {
  const events = [];
  const first = buildToolTimelineEvent({
    index: 4,
    toolName: "Write",
    params: {
      path: "outbox/runtime_result.json",
    },
    error: "[EXECUTION HALTED] runtime 已完成本轮工具阶段;请用普通文本给出最终结果。",
    observedAt: 1000,
  });
  const second = buildToolTimelineEvent({
    index: 5,
    toolName: "Write",
    params: {
      path: "outbox/runtime_result.json",
    },
    error: "[EXECUTION HALTED] runtime 已完成本轮工具阶段;请用普通文本给出最终结果。",
    observedAt: 1100,
  });

  appendToolTimelineEvent(events, first);
  appendToolTimelineEvent(events, second);

  assert.equal(events.length, 1);
  assert.equal(events[0].repeatCount, 2);
  assert.equal(events[0].lastTs, 1100);
});
