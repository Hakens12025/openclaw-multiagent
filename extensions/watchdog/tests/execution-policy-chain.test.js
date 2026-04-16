import test from "node:test";
import assert from "node:assert/strict";
import {
  hasExecutionPolicy,
  registerRuntimeAgents,
} from "../lib/agent/agent-identity.js";
import { runtimeAgentConfigs } from "../lib/state.js";

function cleanup() {
  runtimeAgentConfigs.clear();
}

test("hasExecutionPolicy returns true for evaluator noDirectIntake", () => {
  try {
    registerRuntimeAgents({
      agents: {
        list: [
          {
            id: "evaluator",
            binding: {
              roleRef: "evaluator",
              policies: {
                executionPolicy: {
                  noDirectIntake: true,
                },
              },
            },
          },
        ],
      },
    });
    assert.equal(hasExecutionPolicy("evaluator", "noDirectIntake"), true);
  } finally {
    cleanup();
  }
});

test("hasExecutionPolicy returns false for agent without noDirectIntake", () => {
  try {
    registerRuntimeAgents({
      agents: {
        list: [
          {
            id: "worker-a",
            binding: {
              roleRef: "executor",
            },
          },
        ],
      },
    });
    assert.equal(hasExecutionPolicy("worker-a", "noDirectIntake"), false);
  } finally {
    cleanup();
  }
});
