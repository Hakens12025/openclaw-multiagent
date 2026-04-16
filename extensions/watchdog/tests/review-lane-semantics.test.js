import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { loadGraph, saveGraph } from "../lib/agent/agent-graph.js";
import { runtimeAgentConfigs, agentWorkspace } from "../lib/state.js";
import { SYSTEM_ACTION_STATUS } from "../lib/core/runtime-status.js";
import { systemActionRunRequestReview } from "../lib/system-action/system-action-request-review.js";
import { deliveryRunSystemActionReviewVerdict } from "../lib/routing/delivery-system-action-review-verdict.js";
import { buildDeferredSystemActionFollowUp } from "../lib/system-action/system-action-runtime-ledger.js";
import { runGlobalTestEnvironmentSerial } from "./test-locks.js";

const logger = {
  info() {},
  warn() {},
  error() {},
};

function setRuntimeAgents(entries) {
  runtimeAgentConfigs.clear();
  for (const entry of entries) {
    runtimeAgentConfigs.set(entry.id, entry);
  }
}

function buildApi() {
  return {
    runtime: {
      system: {
        requestHeartbeatNow() {},
      },
    },
  };
}

test("request_review resolves a graph-authorized reviewer lane instead of guessing an executor handler", async () => runGlobalTestEnvironmentSerial(async () => {
  const previousRuntimeConfigs = new Map(runtimeAgentConfigs);
  const previousGraph = await loadGraph();
  const sourceAgentId = `review-source-${Date.now()}`;
  const otherExecutorId = `review-other-executor-${Date.now()}`;
  const reviewerAgentId = `review-target-${Date.now()}`;

  try {
    setRuntimeAgents([
      { id: sourceAgentId, role: "executor", specialized: true, workspace: agentWorkspace(sourceAgentId) },
      { id: otherExecutorId, role: "executor", specialized: false, workspace: agentWorkspace(otherExecutorId) },
      { id: reviewerAgentId, role: "reviewer", workspace: agentWorkspace(reviewerAgentId) },
    ]);
    await saveGraph({
      edges: [
        { from: sourceAgentId, to: reviewerAgentId, label: "review" },
      ],
    });

    const result = await systemActionRunRequestReview({
      type: "request_review",
      params: {
        instruction: "请审查这个实现",
        artifactManifest: [{ path: "/tmp/demo-artifact.js", label: "demo" }],
      },
    }, {
      agentId: sourceAgentId,
      sessionKey: `agent:${sourceAgentId}:main`,
      contractData: {
        id: `TC-REVIEW-${Date.now()}`,
        replyTo: { agentId: "controller", sessionKey: "agent:controller:main" },
      },
      api: buildApi(),
      logger,
      actionReplyTo: { agentId: sourceAgentId, sessionKey: `agent:${sourceAgentId}:main` },
    });

    assert.equal(result.status, SYSTEM_ACTION_STATUS.DISPATCHED);
    assert.equal(result.targetAgent, reviewerAgentId);

    const reviewRequest = JSON.parse(
      await readFile(join(agentWorkspace(reviewerAgentId), "inbox", "code_review.json"), "utf8"),
    );
    assert.equal(reviewRequest.coordination?.owner?.agentId, reviewerAgentId);
  } finally {
    runtimeAgentConfigs.clear();
    for (const [key, value] of previousRuntimeConfigs.entries()) {
      runtimeAgentConfigs.set(key, value);
    }
    await saveGraph(previousGraph);
    await rm(agentWorkspace(sourceAgentId), { recursive: true, force: true });
    await rm(agentWorkspace(otherExecutorId), { recursive: true, force: true });
    await rm(agentWorkspace(reviewerAgentId), { recursive: true, force: true });
  }
}));

test("request_review accepts any graph-authorized source agent instead of only specialized executors", async () => runGlobalTestEnvironmentSerial(async () => {
  const previousRuntimeConfigs = new Map(runtimeAgentConfigs);
  const previousGraph = await loadGraph();
  const sourceAgentId = `review-planner-source-${Date.now()}`;
  const reviewerAgentId = `review-planner-target-${Date.now()}`;

  try {
    setRuntimeAgents([
      { id: sourceAgentId, role: "planner", specialized: false, workspace: agentWorkspace(sourceAgentId) },
      { id: reviewerAgentId, role: "reviewer", workspace: agentWorkspace(reviewerAgentId) },
    ]);
    await saveGraph({
      edges: [
        { from: sourceAgentId, to: reviewerAgentId, label: "review" },
      ],
    });

    const result = await systemActionRunRequestReview({
      type: "request_review",
      params: {
        instruction: "请审查规划后的结果",
        artifactManifest: [{ path: "/tmp/demo-plan.md", label: "plan" }],
      },
    }, {
      agentId: sourceAgentId,
      sessionKey: `agent:${sourceAgentId}:main`,
      contractData: {
        id: `TC-REVIEW-PLANNER-${Date.now()}`,
        replyTo: { agentId: "controller", sessionKey: "agent:controller:main" },
      },
      api: buildApi(),
      logger,
      actionReplyTo: { agentId: sourceAgentId, sessionKey: `agent:${sourceAgentId}:main` },
    });

    assert.equal(result.status, SYSTEM_ACTION_STATUS.DISPATCHED);
    assert.equal(result.targetAgent, reviewerAgentId);
  } finally {
    runtimeAgentConfigs.clear();
    for (const [key, value] of previousRuntimeConfigs.entries()) {
      runtimeAgentConfigs.set(key, value);
    }
    await saveGraph(previousGraph);
    await rm(agentWorkspace(sourceAgentId), { recursive: true, force: true });
    await rm(agentWorkspace(reviewerAgentId), { recursive: true, force: true });
  }
}));

test("request_review verdict delivery records the actual reviewer session agent instead of re-resolving executor handlers", async () => {
  const previousRuntimeConfigs = new Map(runtimeAgentConfigs);
  const sourceAgentId = `review-result-source-${Date.now()}`;
  const otherExecutorId = `review-result-executor-${Date.now()}`;
  const reviewerAgentId = `review-result-reviewer-${Date.now()}`;
  const artifactPath = join(agentWorkspace(reviewerAgentId), "inbox", "code_review.json");
  const verdictPath = join(agentWorkspace(reviewerAgentId), "outbox", "code_verdict.json");

  try {
    setRuntimeAgents([
      { id: sourceAgentId, role: "executor", specialized: true, workspace: agentWorkspace(sourceAgentId) },
      { id: otherExecutorId, role: "executor", specialized: false, workspace: agentWorkspace(otherExecutorId) },
      { id: reviewerAgentId, role: "reviewer", workspace: agentWorkspace(reviewerAgentId) },
    ]);
    await mkdir(join(agentWorkspace(reviewerAgentId), "inbox"), { recursive: true });
    await mkdir(join(agentWorkspace(reviewerAgentId), "outbox"), { recursive: true });
    await writeFile(artifactPath, JSON.stringify({ protocol: { source: "request_review" } }, null, 2), "utf8");
    await writeFile(verdictPath, JSON.stringify({ verdict: "reject" }, null, 2), "utf8");

    const result = await deliveryRunSystemActionReviewVerdict({
      trackingState: {
        agentId: reviewerAgentId,
        artifactContext: {
          kind: "code_review",
          path: artifactPath,
          protocol: {
            source: "request_review",
            intentType: "request_review",
          },
          source: {
            agentId: sourceAgentId,
            sessionKey: `agent:${sourceAgentId}:main`,
            contractId: "TC-REVIEW-SOURCE",
          },
          request: {
            instruction: "请审查当前实现",
          },
          replyTo: {
            agentId: sourceAgentId,
            sessionKey: `agent:${sourceAgentId}:main`,
          },
          upstreamReplyTo: {
            agentId: "controller",
            sessionKey: "agent:controller:main",
          },
          returnContext: {
            sourceAgentId,
            sourceSessionKey: `agent:${sourceAgentId}:main`,
            intentType: "request_review",
          },
          coordination: {
            ownerAgentId: reviewerAgentId,
          },
          systemActionDeliveryTicket: {
            id: `ticket-${Date.now()}`,
          },
          domain: "generic",
        },
      },
      executionObservation: {
        reviewVerdict: {
          verdict: "reject",
          feedback: "缺少关键验证",
          issues: [],
        },
        reviewerResult: {
          verdict: "fail",
          findings: [{ message: "缺少关键验证" }],
        },
      },
      api: buildApi(),
      logger,
    });

    assert.equal(result.handled, true);
    const delivered = JSON.parse(
      await readFile(join(agentWorkspace(sourceAgentId), "inbox", "contract.json"), "utf8"),
    );
    assert.equal(delivered.systemActionDelivery?.reviewerAgentId, reviewerAgentId);
  } finally {
    runtimeAgentConfigs.clear();
    for (const [key, value] of previousRuntimeConfigs.entries()) {
      runtimeAgentConfigs.set(key, value);
    }
    await rm(agentWorkspace(sourceAgentId), { recursive: true, force: true });
    await rm(agentWorkspace(otherExecutorId), { recursive: true, force: true });
    await rm(agentWorkspace(reviewerAgentId), { recursive: true, force: true });
  }
});

test("deferred request_review follow-up does not fabricate reviewer identity from executor handlers", () => {
  const previousRuntimeConfigs = new Map(runtimeAgentConfigs);

  try {
    setRuntimeAgents([
      { id: "worker-a", role: "executor", specialized: true, workspace: agentWorkspace("worker-a") },
    ]);

    const followUp = buildDeferredSystemActionFollowUp({
      actionType: "request_review",
      status: SYSTEM_ACTION_STATUS.DISPATCHED,
      deferredCompletion: true,
    });

    assert.equal(followUp?.reviewerAgentId, null);
  } finally {
    runtimeAgentConfigs.clear();
    for (const [key, value] of previousRuntimeConfigs.entries()) {
      runtimeAgentConfigs.set(key, value);
    }
  }
});
