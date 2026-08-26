import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  clearAllSessions,
  trackToolCall,
} from "../lib/runtime/execution-hard-stop-registry.js";
import { persistContractById } from "../lib/contract/contracts.js";
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

mock.module("../lib/routing/dispatch/dispatch-graph-policy.js", {
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

const { listAgentEndMainStages } = await import("../lib/lifecycle/agent-end/lifecycle.js");

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

async function persistRoutedContractSnapshot({ contractId, output = "" }) {
  const contractPath = await persistContractById({
    id: contractId,
    task: `graph route test ${contractId}`,
    assignee: "worker-3",
    output,
    status: CONTRACT_STATUS.RUNNING,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    protocol: {
      version: 1,
      envelope: "execution_contract",
      source: "test",
    },
  }, logger);
  return contractPath;
}

test("graph_route owns a shared contract that follows the next graph edge", async () => {
  clearAllSessions();
  resetRouteMocks();

  const graphRouteStage = listAgentEndMainStages().find((stage) => stage.id === "graph_route");
  assert.ok(graphRouteStage, "expected graph_route stage to exist");

  const contractId = `TC-shared-follow-${Date.now()}`;
  const contractPath = await persistRoutedContractSnapshot({ contractId });

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
  clearAllSessions();
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

  const contractId = "TC-shared-hard-stop";
  const contractPath = await persistRoutedContractSnapshot({
    contractId,
    output: "/tmp/TC-shared-hard-stop.md",
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
          output: "/tmp/TC-shared-hard-stop.md",
        },
      },
      effectiveContractData: {
        id: contractId,
        path: contractPath,
        taskType: "execution_contract",
        output: "/tmp/TC-shared-hard-stop.md",
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
    // source 是执行硬停闸的署名(旧错名 loop_runtime,与图回路无关);字面量断言,
    // 该字段无枚举校验,引常量等于放任改名静默漂移。
    assert.equal(context.graphRouteResult?.terminalOutcome?.source, "execution_hard_stop");
    // summary 必须来自 hard-stop-terminalize 的正版分表,不是本文件的平行拷贝。
    assert.equal(
      context.graphRouteResult?.terminalOutcome?.summary,
      "session terminated due to repeated identical tool calls before final output was committed",
    );
  } finally {
    await rm(contractPath, { force: true });
  }
});

test("graph_route holds a hard-stopped leg terminal when the artifact exists but was never committed", async () => {
  // 判决面重做(2026-08-10):旧行为「硬停但盘上有产物 → 照样转发」由恒真存在性谓词
  // (hasSemanticProgressObservation)撑着——正是让交接门在生产里死掉的那一族。
  // 新语义:中断且 agent 没交代 → 产物含义不确定(可能是半成品),不转发、判 terminal。
  // agent 真做完了有两条正路:声明 completed(submit_output),或走 outputCommitted 事实。
  clearAllSessions();
  resetRouteMocks();

  const graphRouteStage = listAgentEndMainStages().find((stage) => stage.id === "graph_route");
  assert.ok(graphRouteStage, "expected graph_route stage to exist");

  const sessionKey = `agent:worker-3:hard-stop-output:${Date.now()}`;
  for (let index = 0; index < 5; index += 1) {
    trackToolCall(sessionKey, "write", {
      file_path: "/tmp/TC-shared-hard-stop-output.md",
      content: "Monday, April 27th, 2026",
    });
  }

  const contractId = "TC-shared-hard-stop-output";
  const outputPath = "/tmp/TC-shared-hard-stop-output.md";
  const contractPath = await persistRoutedContractSnapshot({
    contractId,
    output: outputPath,
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
        },
      },
      effectiveContractData: {
        id: contractId,
        path: contractPath,
        taskType: "execution_contract",
        output: outputPath,
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

    assert.equal(routeCalls.length, 0, "硬停未交代:不转发");
    assert.equal(context.graphRouteResult?.action, "terminal");
    assert.equal(context.graphRouteResult?.terminalOutcome?.status, CONTRACT_STATUS.FAILED);
  } finally {
    await rm(contractPath, { force: true });
    await rm(outputPath, { force: true });
  }
});

test("graph_route still forwards a hard-stopped leg once outputCommitted is an observed fact", async () => {
  // BC-1(回路退役统一口径,2026-08-18):硬停逃生口原先只存在于「不带 pipelineStage」的
  // 普通图路由分支,带 pipelineStage 的回路推进分支硬停即 terminal——同一条命题两个答案。
  // 回路面退役后统一到逃生口这一侧:硬停判的是「会话在原地打转」,而 outputCommitted
  // 是「这一跳的产物已按合约提交」的事实;事实成立时截停等于凭会话形态丢掉一份真产物。
  clearAllSessions();
  resetRouteMocks();

  const graphRouteStage = listAgentEndMainStages().find((stage) => stage.id === "graph_route");
  assert.ok(graphRouteStage, "expected graph_route stage to exist");

  const sessionKey = `agent:worker-3:hard-stop-committed:${Date.now()}`;
  for (let index = 0; index < 5; index += 1) {
    trackToolCall(sessionKey, "write", {
      file_path: "/tmp/TC-shared-hard-stop-committed.md",
      content: "Monday, April 27th, 2026",
    });
  }

  const contractId = "TC-shared-hard-stop-committed";
  const outputPath = "/tmp/TC-shared-hard-stop-committed.md";
  const contractPath = await persistRoutedContractSnapshot({
    contractId,
    output: outputPath,
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
          runtimeDiagnostics: {
            executionTrace: { outputCommitted: true },
          },
        },
      },
      effectiveContractData: {
        id: contractId,
        path: contractPath,
        taskType: "execution_contract",
        output: outputPath,
        runtimeDiagnostics: {
          executionTrace: { outputCommitted: true },
        },
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

    assert.equal(routeCalls.length, 1, "硬停 + 产物已提交:照转");
    assert.equal(routeCalls[0][1], contractId);
    assert.equal(context.graphRouted, true);
    assert.equal(context.graphRouteResult?.target, "worker-4");
    assert.equal(context.graphRouteResult?.terminalOutcome, undefined);
  } finally {
    await rm(contractPath, { force: true });
    await rm(outputPath, { force: true });
  }
});

test("graph_route settles a hard-stopped terminal node on committed output instead of forcing FAILED", async () => {
  // 逃生口原为 `outputCommitted && routable && target` 三条件与运算 —— 终点节点(无出边)
  // routable=false,于是产物已提交也落回硬停终态,收 FAILED 且 summary 写
  // "before final output was committed",与事实相反。判据本来就是「已提交事实说明这一跳
  // 交付完整」,与出边有无无关:出边只决定要不要转发,不决定这一跳成没成。
  // 本例锁终点侧:不转发,但也不带硬停终态 —— 收口交回 terminal.js 正版分表。
  clearAllSessions();
  resetRouteMocks();
  mockedResolvedRouteAfterAgentEndTarget = {
    routable: false,
    action: "terminal",
    target: null,
  };

  const graphRouteStage = listAgentEndMainStages().find((stage) => stage.id === "graph_route");
  assert.ok(graphRouteStage, "expected graph_route stage to exist");

  const sessionKey = `agent:worker-3:hard-stop-terminal-node:${Date.now()}`;
  for (let index = 0; index < 5; index += 1) {
    trackToolCall(sessionKey, "write", {
      file_path: "/tmp/TC-shared-hard-stop-terminal-node.md",
      content: "Monday, April 27th, 2026",
    });
  }

  const contractId = "TC-shared-hard-stop-terminal-node";
  const outputPath = "/tmp/TC-shared-hard-stop-terminal-node.md";
  const contractPath = await persistRoutedContractSnapshot({
    contractId,
    output: outputPath,
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
          runtimeDiagnostics: {
            executionTrace: { outputCommitted: true },
          },
        },
      },
      effectiveContractData: {
        id: contractId,
        path: contractPath,
        taskType: "execution_contract",
        output: outputPath,
        runtimeDiagnostics: {
          executionTrace: { outputCommitted: true },
        },
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

    assert.equal(routeCalls.length, 0, "终点节点无下一跳:不转发");
    assert.equal(context.graphRouteResult?.action, "terminal");
    assert.equal(context.graphRouted, undefined);
    assert.equal(context.graphOwned, undefined, "terminal 不归 graph_route 管生命周期");
    assert.equal(
      context.graphRouteResult?.terminalOutcome,
      undefined,
      "终点节点 + 产物已提交:不得盖硬停 FAILED 终态,收口交回 terminal.js 正版分表",
    );
    assert.equal(context.graphRouteResult?.reason, "repeat_threshold", "硬停 reason 仍作留痕");
  } finally {
    await rm(contractPath, { force: true });
    await rm(outputPath, { force: true });
  }
});

test("graph_route continues canonical outbox commits when protocol carries non-routing metadata", async () => {
  clearAllSessions();
  resetRouteMocks();

  const graphRouteStage = listAgentEndMainStages().find((stage) => stage.id === "graph_route");
  assert.ok(graphRouteStage, "expected graph_route stage to exist");

  const contractId = `TC-protocol-metadata-${Date.now()}`;
  const contractPath = await persistRoutedContractSnapshot({
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
    const contractPath = await persistRoutedContractSnapshot({
      contractId,
      output: outputPath,
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
  // 故意保留 routeAfterAgentEnd 的默认 mock(routed:true/dispatched/worker-4):
  // 不可路由分支再调它一次纯属白跑第二次 loadGraph,已删。真被调到时
  // routeCalls 与 action 两条断言会一起翻红。

  const graphRouteStage = listAgentEndMainStages().find((stage) => stage.id === "graph_route");
  assert.ok(graphRouteStage, "expected graph_route stage to exist");

  const contractId = `TC-ordinary-ambiguous-${Date.now()}`;
  const contractPath = await persistRoutedContractSnapshot({ contractId });

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
    assert.equal(routeCalls.length, 0, "不可路由:不得再走一次 routeAfterAgentEnd(第二次 loadGraph)");
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
  const contractPath = await persistRoutedContractSnapshot({ contractId });

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
