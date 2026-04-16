import test, { mock } from "node:test";
import assert from "node:assert/strict";

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

  const graphRouteStage = listAgentEndMainStages().find((stage) => stage.id === "graph_route");
  assert.ok(graphRouteStage, "expected graph_route stage to exist");

  const context = {
    agentId: "worker-3",
    event: { success: true },
    trackingState: {
      contract: {
        id: "TC-loop-shared",
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
      id: "TC-loop-shared",
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
      contractId: "TC-loop-shared",
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

  assert.equal(graphRouteStage.match(context), true);
  await graphRouteStage.run(context);

  assert.equal(routeCalls.length, 1);
  assert.equal(routeCalls[0][0], "worker-3");
  assert.equal(routeCalls[0][1], "TC-loop-shared");
  assert.equal(context.graphRouted, true);
  assert.equal(context.graphRouteResult?.target, "worker-4");
});
