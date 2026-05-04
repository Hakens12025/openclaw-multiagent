import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { getContractPath } from "../lib/contracts.js";
import { LOOP_SESSION_STATE_FILE } from "../lib/loop/loop-session-store.js";

const routeCalls = [];

mock.module("../lib/agent/agent-graph.js", {
  namedExports: {
    normalizeGraphEdges: (edges) => Array.isArray(edges) ? edges : [],
    loadGraph: async () => ({
      edges: [{ from: "worker-3", to: "worker-4", gate: "default" }],
    }),
    saveGraph: async () => {},
    pruneGraphToAgentIds: async () => {},
    addEdge: async () => {},
    removeEdge: async () => {},
    composeLoop: async () => {},
    getEdgesFrom: (graph, agentId) => (graph?.edges || []).filter((edge) => edge.from === agentId),
    getEdgesTo: (graph, agentId) => (graph?.edges || []).filter((edge) => edge.to === agentId),
    getTransitionsForNode: (graph, nodeId) => (graph?.edges || []).filter((edge) => edge.from === nodeId),
    hasDirectedEdge: (graph, from, to) => (graph?.edges || []).some((edge) => edge.from === from && edge.to === to),
    getEdgesFromByGate: (graph, nodeId, gate) => (graph?.edges || []).filter((edge) => edge.from === nodeId && edge.gate === gate),
    getEdgesFromByCapability: () => [],
    detectCycles: () => [],
  },
});

mock.module("../lib/routing/dispatch-graph-policy.js", {
  namedExports: {
    markIdle: async () => false,
    onAgentDone: async () => {},
    drainIdleDispatchTargets: async () => {},
    resolveRouteAfterAgentEndTarget: async () => ({
      routable: true,
      action: "single_edge",
      target: "worker-4",
    }),
    routeAfterAgentEnd: async (...args) => {
      routeCalls.push(args);
      return { routed: true, action: "dispatched", target: "worker-4" };
    },
    dispatchRouteExecutionContract: async () => ({ dispatched: false, queued: false, failed: false }),
    dispatchResolveFirstHop: async () => null,
  },
});

const { listAgentEndMainStages } = await import("../lib/lifecycle/agent-end-pipeline.js");

const logger = {
  info() {},
  warn() {},
  error() {},
};

test("graph_route owns loop-tagged shared contracts even when graph out-edges exist", async () => {
  routeCalls.length = 0;
  const contractId = "TC-loop-shared";
  const contractPath = getContractPath(contractId);
  const originalLoopSessionState = await readFile(LOOP_SESSION_STATE_FILE, "utf8").catch(() => null);

  const graphRouteStage = listAgentEndMainStages().find((stage) => stage.id === "graph_route");
  assert.ok(graphRouteStage, "expected graph_route stage to exist");

  const context = {
    agentId: "worker-3",
    event: { success: true },
    trackingState: {
      contract: {
        id: contractId,
        pipelineStage: {
          pipelineId: "live-loop-worker3-worker4",
          loopId: "live-loop-worker3-worker4",
          loopSessionId: "LS-test",
          stage: "worker-3",
          round: 1,
        },
      },
    },
    effectiveContractData: {
      id: contractId,
      taskType: "execution_contract",
      pipelineStage: {
        pipelineId: "live-loop-worker3-worker4",
        loopId: "live-loop-worker3-worker4",
        loopSessionId: "LS-test",
        stage: "worker-3",
        round: 1,
      },
    },
    executionObservation: {
      contractId,
      stageRunResult: {
        stage: "worker-3",
        status: "completed",
        summary: "worker-3 stage done",
        feedback: "worker-3 stage done",
        primaryArtifactPath: "/tmp/worker-3-output.md",
        artifacts: [
          {
            type: "text_output",
            path: "/tmp/worker-3-output.md",
            label: "worker-3-output.md",
            required: true,
            primary: true,
          },
        ],
      },
      stageCompletion: {
        status: "completed",
        feedback: "worker-3 stage done",
        transition: {
          kind: "follow_graph",
          reason: "unique_edge",
        },
      },
    },
    logger,
    api: {},
  };

  try {
    await mkdir(dirname(contractPath), { recursive: true });
    await mkdir(dirname(LOOP_SESSION_STATE_FILE), { recursive: true });
    await writeFile(contractPath, JSON.stringify({
      id: contractId,
      status: "running",
      task: "loop shared contract",
      pipelineStage: context.effectiveContractData.pipelineStage,
    }, null, 2), "utf8");
    await writeFile(LOOP_SESSION_STATE_FILE, JSON.stringify({
      activeSession: {
        id: "LS-test",
        loopId: "live-loop-worker3-worker4",
        pipelineId: "live-loop-worker3-worker4",
        kind: "cycle-loop",
        entryAgentId: "worker-3",
        startAgentId: "worker-3",
        currentStage: "worker-3",
        round: 1,
        status: "active",
        nodes: ["worker-3", "worker-4"],
        phaseOrder: ["worker-3", "worker-4"],
        transitionCount: 0,
        startedAt: Date.now(),
        updatedAt: Date.now(),
      },
      recentSessions: [],
    }, null, 2), "utf8");

    assert.equal(graphRouteStage.match(context), true);
    await graphRouteStage.run(context);

    assert.equal(routeCalls.length, 1);
    assert.equal(routeCalls[0][0], "worker-3");
    assert.equal(routeCalls[0][1], contractId);
    assert.equal(context.graphRouted, true);
    assert.equal(context.graphRouteResult?.target, "worker-4");
  } finally {
    await unlink(contractPath).catch(() => {});
    if (originalLoopSessionState == null) {
      await rm(LOOP_SESSION_STATE_FILE, { force: true });
    } else {
      await writeFile(LOOP_SESSION_STATE_FILE, originalLoopSessionState, "utf8");
    }
  }
});
