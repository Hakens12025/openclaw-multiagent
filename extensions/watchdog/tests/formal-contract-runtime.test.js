import test from "node:test";
import assert from "node:assert/strict";

import {
  classifyContractExecutionMode,
  getFormalContractCasePolicy,
} from "./formal-contract-runtime.js";

test("loop-elevated contract runtime is accepted by explicit system action state", () => {
  const result = classifyContractExecutionMode({
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
  const result = classifyContractExecutionMode({
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

test("invalid legacy contractor start_loop remains a failed contract runtime", () => {
  const result = classifyContractExecutionMode({
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

test("formal contract cases keep explicit execution-mode policy", () => {
  assert.deepEqual(getFormalContractCasePolicy("complex-02"), {
    allowLoopElevation: false,
    requiredExecutionMode: "worker",
  });

  assert.deepEqual(getFormalContractCasePolicy("complex-03"), {
    allowLoopElevation: false,
    requiredExecutionMode: "worker",
  });
});
