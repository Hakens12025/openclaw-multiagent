import test from "node:test";
import assert from "node:assert/strict";

import {
  classifyFullPathExecutionMode,
  getFormalFullPathCasePolicy,
} from "./formal-full-path-runtime.js";

test("loop-elevated full-path runtime is accepted without worker-only checkpoints", () => {
  const result = classifyFullPathExecutionMode({
    contractRuntime: {
      status: "completed",
      systemAction: {
        type: "start_loop",
        status: "dispatched",
        targetAgent: "researcher",
      },
    },
  });

  assert.deepEqual(result, {
    mode: "loop",
    accepted: true,
    targetAgent: "researcher",
    reason: null,
  });
});

test("invalid start_loop remains a runtime failure", () => {
  const result = classifyFullPathExecutionMode({
    contractRuntime: {
      status: "failed",
      systemAction: {
        type: "start_loop",
        status: "invalid_params",
        error: "no startAgent specified",
        targetAgent: null,
      },
    },
  });

  assert.deepEqual(result, {
    mode: "failed",
    accepted: false,
    targetAgent: null,
    reason: "no startAgent specified",
  });
});

test("invalid legacy contractor start_loop remains a failed full-path runtime", () => {
  const result = classifyFullPathExecutionMode({
    contractRuntime: {
      status: "pending",
      assignee: "worker",
      systemAction: {
        type: "start_loop",
        status: "invalid_params",
        error: "no startAgent specified",
        targetAgent: null,
      },
    },
  });

  assert.deepEqual(result, {
    mode: "failed",
    accepted: false,
    targetAgent: null,
    reason: "no startAgent specified",
  });
});

test("formal full-path cases remain worker-only", () => {
  assert.deepEqual(getFormalFullPathCasePolicy("complex-02"), {
    allowLoopElevation: false,
    requiredExecutionMode: "worker",
  });

  assert.deepEqual(getFormalFullPathCasePolicy("complex-03"), {
    allowLoopElevation: false,
    requiredExecutionMode: "worker",
  });
});
