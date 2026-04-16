import test from "node:test";
import assert from "node:assert/strict";

import {
  resolveStartLoopParams,
} from "../lib/system-action/system-action-consumer.js";
import {
  refreshEffectiveContractDataAfterTransport,
} from "../lib/lifecycle/agent-end-pipeline.js";
import { getContractPath, persistContractSnapshot } from "../lib/contracts.js";

test("start_loop does not infer params from planning context", () => {
  const params = resolveStartLoopParams(
    {
      type: "start_loop",
      params: {},
    },
    {
      task: "对比 React、Vue、Svelte 三个框架的优缺点，写一份报告",
      planningContext: {
        activeLoopCandidates: [
          {
            loopId: "live-loop-direct-1",
            entryAgentId: "researcher",
            nodes: ["researcher", "worker-d", "evaluator"],
          },
          {
            loopId: "research-loop",
            entryAgentId: "researcher",
            nodes: ["researcher", "worker-d", "evaluator"],
          },
        ],
      },
    },
  );

  assert.equal(params.startAgent, undefined);
  assert.equal(params.requestedTask, undefined);
  assert.equal(params.loopId, undefined);
  assert.equal(params.pipelineId, undefined);
});

test("explicit current-shape start_loop params pass through unchanged", () => {
  const params = resolveStartLoopParams(
    {
      type: "start_loop",
      params: {
        startAgent: "worker-d",
        requestedTask: "explicit override check",
      },
    },
    {
      task: "explicit override check",
      planningContext: {
        activeLoopCandidates: [
          {
            loopId: "research-loop",
            entryAgentId: "researcher",
            nodes: ["researcher", "worker-d", "evaluator"],
          },
        ],
      },
    },
  );

  assert.equal(params.startAgent, "worker-d");
  assert.equal(params.requestedTask, "explicit override check");
  assert.equal(params.loopId, undefined);
  assert.equal(params.pipelineId, undefined);
});

test("start_loop does not derive loop truth from root contract fields", () => {
  const params = resolveStartLoopParams(
    {
      type: "start_loop",
      params: {},
    },
    {
      task: "root planning truth fallback",
      pipeline: {
        loopId: "research-loop",
      },
      planningDecision: {
        selectedLoop: "research-loop",
      },
      planningContext: {
        activeLoopCandidates: [
          {
            loopId: "research-loop",
            entryAgentId: "researcher",
            nodes: ["researcher", "worker-d", "evaluator"],
          },
          {
            loopId: "other-loop",
            entryAgentId: "worker-a",
            nodes: ["worker-a", "evaluator"],
          },
        ],
      },
    },
  );

  assert.equal(params.loopId, undefined);
  assert.equal(params.pipelineId, undefined);
  assert.equal(params.startAgent, undefined);
});

test("transport refresh reloads the newest root contract before consume_system_action", async () => {
  const contractId = `TC-REFRESH-${Date.now()}`;
  const contractPath = getContractPath(contractId);

  try {
    await persistContractSnapshot(contractPath, {
      id: contractId,
      task: "refresh latest contract snapshot",
      status: "pending",
      assignee: "worker",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      phases: [],
      total: 1,
      output: `/tmp/${contractId}.md`,
      planningContext: {
        activeLoopCandidates: [
          {
            loopId: "research-loop",
            entryAgentId: "researcher",
            nodes: ["researcher", "worker-d", "evaluator"],
          },
        ],
      },
      pipeline: {
        loopId: "research-loop",
      },
      planningDecision: {
        selectedLoop: "research-loop",
      },
      protocol: {
        version: 1,
        envelope: "execution_contract",
      },
    }, { info() {}, warn() {}, error() {} });

    const context = {
      trackingState: {
        contract: {
          id: contractId,
          path: contractPath,
        },
      },
      executionObservation: {
        contractId,
      },
      contractData: {
        id: contractId,
        task: "stale snapshot",
      },
      effectiveContractData: {
        id: contractId,
        task: "stale snapshot",
      },
      logger: { info() {}, warn() {}, error() {} },
    };

    await refreshEffectiveContractDataAfterTransport(context);

    assert.equal(context.effectiveContractData?.pipeline?.loopId, "research-loop");
    assert.equal(context.effectiveContractData?.planningDecision?.selectedLoop, "research-loop");
  } finally {
    await import("node:fs/promises").then(({ unlink }) => unlink(contractPath).catch(() => {}));
  }
});
