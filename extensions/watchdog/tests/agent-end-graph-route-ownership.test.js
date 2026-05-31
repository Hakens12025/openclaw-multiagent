import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  clearAllSessions,
  trackToolCall,
} from "../lib/loop/loop-detection.js";
import { getContractPath, persistContractSnapshot } from "../lib/contracts.js";
import { CONTRACT_STATUS } from "../lib/core/runtime-status.js";

const routeCalls = [];
let mockedResolvedRouteAfterAgentEndTarget = {
  routable: true,
  action: "single_edge",
  target: "worker-4",
};
let mockedRouteAfterAgentEndResult = {
  routed: true,
  action: "dispatched",
  target: "worker-4",
};

mock.module("../lib/agent/agent-graph.js", {
  namedExports: {
    normalizeGraphEdges: (edges) => Array.isArray(edges) ? edges : [],
    loadGraph: async () => ({
      edges: [{ from: "worker-3", to: "worker-4" }],
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
    detectCycles: () => [],
  },
});

mock.module("../lib/routing/dispatch-graph-policy.js", {
  namedExports: {
    markIdle: async () => false,
    onAgentDone: async () => {},
    drainIdleDispatchTargets: async () => {},
    resolveRouteAfterAgentEndTarget: async () => mockedResolvedRouteAfterAgentEndTarget,
    routeAfterAgentEnd: async (...args) => {
      routeCalls.push(args);
      return mockedRouteAfterAgentEndResult;
    },
    dispatchRouteExecutionContract: async () => ({ dispatched: false, queued: false, failed: false }),
    dispatchResolveFirstHop: async () => null,
  },
});

mock.module("../lib/loop/graph-loop-registry.js", {
  namedExports: {
    findActiveGraphLoopsByMemberAgent: () => [],
    listResolvedGraphLoops: async () => ([
      {
        id: "live-loop-worker3-worker4",
        entryAgentId: "worker-3",
        nodes: ["worker-3", "worker-4"],
      },
    ]),
  },
});

mock.module("../lib/loop/loop-session-store.js", {
  namedExports: {
    clearActiveLoopSession: async () => {},
    concludeLoopSession: async () => null,
    listResolvedLoopSessions: async () => [],
    loadLoopSessionState: async () => ({
      activeSession: {
        id: "LS-test",
        round: 1,
        budget: null,
      },
      recentSessions: [
        {
          id: "LS-test",
          status: "active",
          round: 1,
          budget: null,
        },
      ],
    }),
    startLoopSession: async () => ({
      id: "LS-test",
      loopId: "live-loop-worker3-worker4",
      currentStage: "worker-3",
      round: 1,
      budget: null,
    }),
    advanceLoopSession: async () => {},
  },
});

const { listAgentEndMainStages } = await import("../lib/lifecycle/agent-end-lifecycle.js");

const logger = {
  info() {},
  warn() {},
  error() {},
};

function resetRouteMocks() {
  routeCalls.length = 0;
  mockedResolvedRouteAfterAgentEndTarget = {
    routable: true,
    action: "single_edge",
    target: "worker-4",
  };
  mockedRouteAfterAgentEndResult = {
    routed: true,
    action: "dispatched",
    target: "worker-4",
  };
}

async function persistLoopContractSnapshot({
  contractId,
  output = "",
  pipelineStage,
}) {
  const contractPath = getContractPath(contractId);
  await persistContractSnapshot(contractPath, {
    id: contractId,
    task: `loop route test ${contractId}`,
    assignee: pipelineStage?.stage || "worker-3",
    output,
    status: CONTRACT_STATUS.RUNNING,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    protocol: {
      version: 1,
      envelope: "execution_contract",
      source: "test",
    },
    pipelineStage: pipelineStage ? { ...pipelineStage } : null,
  }, logger);
  return contractPath;
}

test("graph_route owns loop-tagged shared contracts even when graph out-edges exist", async () => {
  resetRouteMocks();

  const graphRouteStage = listAgentEndMainStages().find((stage) => stage.id === "graph_route");
  assert.ok(graphRouteStage, "expected graph_route stage to exist");

  const contractId = "TC-loop-shared";
  const pipelineStage = {
    pipelineId: "live-loop-worker3-worker4",
    loopId: "live-loop-worker3-worker4",
    loopSessionId: "LS-test",
    stage: "worker-3",
    round: 1,
  };
  const contractPath = await persistLoopContractSnapshot({
    contractId,
    pipelineStage,
  });

  try {
    const context = {
      agentId: "worker-3",
      event: { success: true },
      trackingState: {
        contract: {
          id: contractId,
          path: contractPath,
          pipelineStage,
        },
      },
      effectiveContractData: {
        id: contractId,
        path: contractPath,
        taskType: "execution_contract",
        pipelineStage,
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

    assert.equal(graphRouteStage.match(context), true);
    await graphRouteStage.run(context);

    assert.equal(routeCalls.length, 1);
    assert.equal(routeCalls[0][0], "worker-3");
    assert.equal(routeCalls[0][1], contractId);
    assert.equal(context.graphRouted, true);
    assert.equal(context.graphRouteResult?.target, "worker-4");
  } finally {
    await rm(contractPath, { force: true });
  }
});

test("graph_route routes execution contracts by envelope truth instead of DIRECT id prefix", async () => {
  resetRouteMocks();

  const graphRouteStage = listAgentEndMainStages().find((stage) => stage.id === "graph_route");
  assert.ok(graphRouteStage, "expected graph_route stage to exist");

  const contractId = "DIRECT-EXECUTION-CONTRACT";
  const context = {
    agentId: "worker-3",
    event: { success: true },
    trackingState: {
      contract: {
        id: contractId,
        protocol: {
          version: 1,
          envelope: "execution_contract",
        },
      },
    },
    effectiveContractData: {
      id: contractId,
      task: "DIRECT prefix is not protocol truth",
      protocol: {
        version: 1,
        envelope: "execution_contract",
      },
    },
    executionObservation: {
      contractId,
    },
    logger,
    api: {},
  };

  assert.equal(graphRouteStage.match(context), true);
  await graphRouteStage.run(context);

  assert.equal(routeCalls.length, 1);
  assert.equal(routeCalls[0][0], "worker-3");
  assert.equal(routeCalls[0][1], contractId);
  assert.equal(context.graphRouted, true);
  assert.equal(context.graphRouteResult?.target, "worker-4");
});

test("graph_route does not forward a contract when the current session is hard-stopped", async () => {
  clearAllSessions();
  resetRouteMocks();

  const graphRouteStage = listAgentEndMainStages().find((stage) => stage.id === "graph_route");
  assert.ok(graphRouteStage, "expected graph_route stage to exist");

  const sessionKey = `agent:worker-3:hard-stop:${Date.now()}`;
  for (let index = 0; index < 5; index += 1) {
    trackToolCall(sessionKey, "read", { path: "inbox/contract.json" });
  }

  const contractId = "TC-loop-hard-stop";
  const pipelineStage = {
    pipelineId: "live-loop-worker3-worker4",
    loopId: "live-loop-worker3-worker4",
    loopSessionId: "LS-test",
    stage: "worker-3",
    round: 1,
  };
  const contractPath = await persistLoopContractSnapshot({
    contractId,
    output: "/tmp/TC-loop-hard-stop.md",
    pipelineStage,
  });

  try {
    const context = {
      agentId: "worker-3",
      sessionKey,
      event: { success: true },
      trackingState: {
        contract: {
          id: contractId,
          path: contractPath,
          output: "/tmp/TC-loop-hard-stop.md",
          pipelineStage,
        },
      },
      effectiveContractData: {
        id: contractId,
        path: contractPath,
        taskType: "execution_contract",
        output: "/tmp/TC-loop-hard-stop.md",
        pipelineStage,
      },
      executionObservation: {
        contractId,
      },
      logger,
      api: {},
    };

    assert.equal(graphRouteStage.match(context), true);
    await graphRouteStage.run(context);

    assert.equal(routeCalls.length, 0);
    assert.equal(context.graphRouted, undefined);
    assert.equal(context.graphRouteResult?.action, "terminal");
    assert.equal(context.graphRouteResult?.terminalOutcome?.status, "failed");
    assert.match(context.graphRouteResult?.terminalOutcome?.reason || "", /repeat_threshold/u);
  } finally {
    await rm(contractPath, { force: true });
  }
});

test("graph_route treats materialized contract.output as progress, not final delivery", async () => {
  clearAllSessions();
  resetRouteMocks();

  const graphRouteStage = listAgentEndMainStages().find((stage) => stage.id === "graph_route");
  assert.ok(graphRouteStage, "expected graph_route stage to exist");

  const sessionKey = `agent:worker-3:hard-stop-output:${Date.now()}`;
  for (let index = 0; index < 5; index += 1) {
    trackToolCall(sessionKey, "write", {
      file_path: "/tmp/TC-loop-hard-stop-output.md",
      content: "Monday, April 27th, 2026",
    });
  }

  const contractId = "TC-loop-hard-stop-output";
  const outputPath = "/tmp/TC-loop-hard-stop-output.md";
  const pipelineStage = {
    pipelineId: "live-loop-worker3-worker4",
    loopId: "live-loop-worker3-worker4",
    loopSessionId: "LS-test",
    stage: "worker-3",
    round: 1,
  };
  const contractPath = await persistLoopContractSnapshot({
    contractId,
    output: outputPath,
    pipelineStage,
  });

  try {
    await writeFile(outputPath, "Monday, April 27th, 2026\n", "utf8");

    const context = {
      agentId: "worker-3",
      sessionKey,
      event: { success: true },
      trackingState: {
        contract: {
          id: contractId,
          path: contractPath,
          output: outputPath,
          pipelineStage,
        },
      },
      effectiveContractData: {
        id: contractId,
        path: contractPath,
        taskType: "execution_contract",
        output: outputPath,
        pipelineStage,
      },
      executionObservation: {
        contractId,
        primaryOutputPath: outputPath,
        artifactPaths: [outputPath],
      },
      logger,
      api: {},
    };

    assert.equal(graphRouteStage.match(context), true);
    await graphRouteStage.run(context);

    assert.equal(routeCalls.length, 1);
    assert.equal(context.graphRouteResult?.action, "dispatched");
    assert.equal(context.graphRouteResult?.target, "worker-4");
    assert.equal(context.graphRouteResult?.terminalOutcome, undefined);
  } finally {
    await rm(contractPath, { force: true });
    await rm(outputPath, { force: true });
  }
});

test("graph_route continues canonical outbox commits when protocol carries non-routing metadata", async () => {
  resetRouteMocks();

  const graphRouteStage = listAgentEndMainStages().find((stage) => stage.id === "graph_route");
  assert.ok(graphRouteStage, "expected graph_route stage to exist");

  const contractId = `TC-protocol-metadata-${Date.now()}`;
  const contractPath = await persistLoopContractSnapshot({
    contractId,
    output: `/tmp/${contractId}.md`,
  });

  try {
    const context = {
      agentId: "worker-3",
      sessionKey: `agent:worker-3:contract:${contractId.toLowerCase()}`,
      event: {
        success: true,
        synthetic: true,
        protocolBoundary: "canonical_outbox_commit",
      },
      trackingState: {
        sessionKey: `agent:worker-3:contract:${contractId.toLowerCase()}`,
        contract: {
          id: contractId,
          path: contractPath,
          output: `/tmp/${contractId}.md`,
          protocol: {
            version: 1,
            envelope: "execution_contract",
            metadata: { requestedTarget: "worker-4" },
          },
        },
      },
      effectiveContractData: {
        id: contractId,
        path: contractPath,
        taskType: "execution_contract",
        output: `/tmp/${contractId}.md`,
        protocol: {
          version: 1,
          envelope: "execution_contract",
          metadata: { requestedTarget: "worker-4" },
        },
      },
      executionObservation: {
        contractId,
        stageRunResult: {
          stage: "worker-3",
          status: "completed",
          summary: "runtime_result observed",
          feedback: "runtime_result observed",
        },
        stageCompletion: {
          status: "completed",
          feedback: "runtime_result observed",
        },
      },
      logger,
      api: {},
    };

    assert.equal(graphRouteStage.match(context), true);
    await graphRouteStage.run(context);

    assert.equal(routeCalls.length, 1);
    assert.equal(routeCalls[0][0], "worker-3");
    assert.equal(routeCalls[0][1], contractId);
    assert.equal(context.graphRouted, true);
    assert.equal(context.graphRouteResult?.target, "worker-4");
  } finally {
    await rm(contractPath, { force: true });
  }
});

test("graph_route still follows graph after contract.output is already materialized", async () => {
  clearAllSessions();
  resetRouteMocks();

  const graphRouteStage = listAgentEndMainStages().find((stage) => stage.id === "graph_route");
  assert.ok(graphRouteStage, "expected graph_route stage to exist");

  const workspaceDir = await mkdtemp(join(tmpdir(), "openclaw-graph-output-"));
  const outputPath = join(workspaceDir, "final-output.md");

  const contractId = "TC-loop-output-ready";
  const pipelineStage = {
    pipelineId: "live-loop-worker3-worker4",
    loopId: "live-loop-worker3-worker4",
    loopSessionId: "LS-test",
    stage: "worker-3",
    round: 1,
  };

  try {
    await writeFile(outputPath, "这是已经写好的最终答复。\n", "utf8");
    const contractPath = await persistLoopContractSnapshot({
      contractId,
      output: outputPath,
      pipelineStage,
    });

    try {
      const context = {
        agentId: "worker-3",
        sessionKey: `agent:worker-3:output:${Date.now()}`,
        event: { success: true },
        trackingState: {
          contract: {
            id: contractId,
            path: contractPath,
            output: outputPath,
            pipelineStage,
            runtimeDiagnostics: {
              executionTrace: {
                outputCommitted: true,
              },
            },
          },
        },
        effectiveContractData: {
          id: contractId,
          path: contractPath,
          taskType: "execution_contract",
          output: outputPath,
          pipelineStage,
          runtimeDiagnostics: {
            executionTrace: {
              outputCommitted: true,
            },
          },
        },
        executionObservation: {
          contractId,
        },
        logger,
        api: {},
      };

      assert.equal(graphRouteStage.match(context), true);
      await graphRouteStage.run(context);

      assert.equal(routeCalls.length, 1);
      assert.equal(context.graphRouteResult?.action, "dispatched");
      assert.equal(context.graphRouteResult?.target, "worker-4");
      assert.equal(context.graphRouteResult?.terminalOutcome, undefined);
    } finally {
      await rm(contractPath, { force: true });
    }
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("ordinary graph_route follows the next graph edge after contract.output is materialized", async () => {
  clearAllSessions();
  resetRouteMocks();

  const graphRouteStage = listAgentEndMainStages().find((stage) => stage.id === "graph_route");
  assert.ok(graphRouteStage, "expected graph_route stage to exist");

  const workspaceDir = await mkdtemp(join(tmpdir(), "openclaw-graph-output-ordinary-"));
  const outputPath = join(workspaceDir, "final-output.md");
  const contractId = "TC-ordinary-output-ready";

  try {
    await writeFile(outputPath, "这是已经写好的阶段产物。\n", "utf8");
    const contractPath = await persistLoopContractSnapshot({
      contractId,
      output: outputPath,
      pipelineStage: null,
    });

    try {
      const context = {
        agentId: "worker-3",
        sessionKey: `agent:worker-3:contract:${contractId.toLowerCase()}`,
        event: { success: true },
        trackingState: {
          contract: {
            id: contractId,
            path: contractPath,
            output: outputPath,
            runtimeDiagnostics: {
              executionTrace: {
                outputCommitted: true,
              },
            },
          },
        },
        effectiveContractData: {
          id: contractId,
          path: contractPath,
          taskType: "execution_contract",
          output: outputPath,
          runtimeDiagnostics: {
            executionTrace: {
              outputCommitted: true,
            },
          },
        },
        executionObservation: {
          contractId,
        },
        logger,
        api: {},
      };

      assert.equal(graphRouteStage.match(context), true);
      await graphRouteStage.run(context);

      assert.equal(routeCalls.length, 1);
      assert.equal(routeCalls[0][0], "worker-3");
      assert.equal(routeCalls[0][1], contractId);
      assert.equal(context.graphRouted, true);
      assert.equal(context.graphRouteResult?.target, "worker-4");
    } finally {
      await rm(contractPath, { force: true });
    }
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("ordinary graph_route leaves ambiguous topology to terminal lifecycle", async () => {
  clearAllSessions();
  resetRouteMocks();
  mockedResolvedRouteAfterAgentEndTarget = {
    routable: false,
    action: "ambiguous_runtime_transition",
    target: null,
  };
  mockedRouteAfterAgentEndResult = {
    routed: false,
    action: "ambiguous_runtime_transition",
    target: null,
  };

  const graphRouteStage = listAgentEndMainStages().find((stage) => stage.id === "graph_route");
  assert.ok(graphRouteStage, "expected graph_route stage to exist");

  const contractId = `TC-ordinary-ambiguous-${Date.now()}`;
  const contractPath = await persistLoopContractSnapshot({
    contractId,
    pipelineStage: null,
  });

  try {
    const context = {
      agentId: "worker-3",
      sessionKey: `agent:worker-3:contract:${contractId.toLowerCase()}`,
      event: { success: true },
      trackingState: {
        contract: {
          id: contractId,
          path: contractPath,
        },
      },
      effectiveContractData: {
        id: contractId,
        path: contractPath,
        taskType: "execution_contract",
      },
      executionObservation: {
        contractId,
      },
      logger,
      api: {},
    };

    assert.equal(graphRouteStage.match(context), true);
    await graphRouteStage.run(context);

    assert.equal(context.graphOwned, undefined);
    assert.equal(context.graphRouted, undefined);
    assert.equal(context.preserveInbox, undefined);
    assert.equal(context.graphRouteResult?.action, "ambiguous_runtime_transition");
  } finally {
    await rm(contractPath, { force: true });
  }
});

test("ordinary graph_route leaves dispatch failure to terminal lifecycle", async () => {
  clearAllSessions();
  resetRouteMocks();
  mockedRouteAfterAgentEndResult = {
    routed: false,
    action: "dispatch_failed",
    target: "worker-4",
  };

  const graphRouteStage = listAgentEndMainStages().find((stage) => stage.id === "graph_route");
  assert.ok(graphRouteStage, "expected graph_route stage to exist");

  const contractId = `TC-ordinary-dispatch-failed-${Date.now()}`;
  const contractPath = await persistLoopContractSnapshot({
    contractId,
    pipelineStage: null,
  });

  try {
    const context = {
      agentId: "worker-3",
      sessionKey: `agent:worker-3:contract:${contractId.toLowerCase()}`,
      event: { success: true },
      trackingState: {
        contract: {
          id: contractId,
          path: contractPath,
        },
      },
      effectiveContractData: {
        id: contractId,
        path: contractPath,
        taskType: "execution_contract",
      },
      executionObservation: {
        contractId,
      },
      logger,
      api: {},
    };

    assert.equal(graphRouteStage.match(context), true);
    await graphRouteStage.run(context);

    assert.equal(context.graphOwned, undefined);
    assert.equal(context.graphRouted, undefined);
    assert.equal(context.preserveInbox, undefined);
    assert.equal(context.graphRouteResult?.action, "dispatch_failed");
    assert.equal(context.graphRouteResult?.target, "worker-4");
  } finally {
    await rm(contractPath, { force: true });
  }
});
