import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import * as afterToolCallHook from "../hooks/after-tool-call.js";
import { registerRuntimeAgents } from "../lib/agent/agent-identity.js";
import { persistContractById, getContractPath } from "../lib/contract/contracts.js";
import { loadGraph } from "../lib/agent/agent-graph.js";
import { saveGraph as saveGraphUnattributed } from "../lib/agent/agent-graph-mutations.js";

// §13 整写门:测试夹具写图报身份(writer),edge 级差异日志可追溯到本文件。
const saveGraph = (graph) => saveGraphUnattributed(graph, { writer: "test:protocol-commit-reconcile.test.js" });
import {
  clearAllSessionProgress,
  openSessionProgress,
} from "../lib/evidence/session-progress-projection.js";
import { createTrackingState } from "../lib/session/session-bootstrap.js";
import { CONTRACT_STATUS } from "../lib/core/runtime-status.js";
import { clearAllSessions } from "../lib/runtime/execution-hard-stop-registry.js";
import {
  OC,
  agentWorkspace,
  runtimeAgentConfigs,
  taskHistory,
} from "../lib/state.js";
import {
  classifyCanonicalProtocolCommit,
  clearProtocolCommitReconcileState,
  flushProtocolCommitDeferredRelease,
  __setProtocolCommitReconcileGraceMsForTest,
} from "../lib/protocol/protocol-commit-reconcile.js";

// 228a22a 把兜底窗 400ms→30s（agent_end 权威）。本文件验证 reconcile 逻辑本身，
// 不验证 30s 这个常量，故把窗调小，避免每个时序用例真等 30s。文件进程隔离，不影响他处。
__setProtocolCommitReconcileGraceMsForTest(50);
import {
  clearTrackingStore,
  rememberTrackingState,
} from "../lib/store/tracker-store.js";
import {
  clearDispatchQueue,
  claimDispatchTargetContract,
  getDispatchQueueDepth,
  isDispatchTargetBusy,
  releaseDispatchTargetContract,
  resetAllDispatchStates,
  syncDispatchTargetsFromRuntime,
} from "../lib/routing/dispatch/dispatch-runtime-state.js";

const logger = {
  info() {},
  warn() {},
  error() {},
};

function createHookApi() {
  const handlers = new Map();
  return {
    api: {
      on(eventName, handler) {
        handlers.set(eventName, handler);
      },
      runtime: {
        system: {
          requestHeartbeatNow() {},
        },
      },
    },
    getHandler(eventName) {
      const handler = handlers.get(eventName);
      assert.equal(typeof handler, "function", `missing handler for ${eventName}`);
      return handler;
    },
  };
}

function buildRuntimeConfig({ plannerId, workerId, worker2Id = null }) {
  const worker2Entry = worker2Id
    ? [{
        id: worker2Id,
        binding: {
          roleRef: "executor",
          workspace: {
            configured: `~/.openclaw/workspaces/${worker2Id}`,
          },
          model: {
            ref: "demo/executor",
          },
          capabilities: {
            configured: {
              tools: ["read", "write", "edit"],
            },
          },
        },
      }]
    : [];
  return {
    agents: {
      list: [
        {
          id: plannerId,
          binding: {
            roleRef: "planner",
            workspace: {
              configured: `~/.openclaw/workspaces/${plannerId}`,
            },
            model: {
              ref: "demo/planner",
            },
          },
        },
        {
          id: workerId,
          binding: {
            roleRef: "executor",
            workspace: {
              configured: `~/.openclaw/workspaces/${workerId}`,
            },
            model: {
              ref: "demo/executor",
            },
            capabilities: {
              configured: {
                tools: ["read", "write", "edit"],
              },
            },
          },
        },
        ...worker2Entry,
      ],
    },
  };
}

test("canonical outbox commit reconciles running worker session without natural agent_end", async () => {
  const plannerId = `planner-proto-${Date.now()}`;
  const workerId = `worker-proto-${Date.now()}`;
  const workspaceDir = join(OC, "workspaces", workerId);
  const inboxDir = join(workspaceDir, "inbox");
  const outboxDir = join(workspaceDir, "outbox");
  const controllerOutputDir = join(OC, "control-plane", "output");
  const reportName = `protocol-commit-${Date.now()}.md`;
  const reportPath = join(outboxDir, reportName);
  const contractId = `TC-PROTOCOL-COMMIT-${Date.now()}`;
  let contractPath = getContractPath(contractId);
  const finalOutputPath = join(controllerOutputDir, `${contractId}.md`);
  const sessionKey = `agent:${workerId}:protocol-commit`;
  const originalTaskHistoryLength = taskHistory.length;

  registerRuntimeAgents(buildRuntimeConfig({ plannerId, workerId }));
  clearTrackingStore();
  clearAllSessionProgress();

  await mkdir(inboxDir, { recursive: true });
  await mkdir(outboxDir, { recursive: true });
  await mkdir(controllerOutputDir, { recursive: true });

  const sharedContract = {
    id: contractId,
    task: "protocol authoritative commit regression",
    assignee: workerId,
    replyTo: {
      agentId: "controller",
      sessionKey: "agent:controller:main",
    },
    phases: ["分析", "写报告"],
    total: 2,
    output: finalOutputPath,
    status: CONTRACT_STATUS.RUNNING,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    protocol: {
      version: 1,
      envelope: "execution_contract",
      transport: "contracts/*.json",
      source: "test",
    },
  };

  const trackingState = createTrackingState({
    sessionKey,
    agentId: workerId,
    parentSession: null,
  });
  trackingState.contract = {
    ...sharedContract,
    path: contractPath,
  };

  const { api, getHandler } = createHookApi();
  afterToolCallHook.register(api, logger, {
    wakeContractor: async () => null,
  });

  try {
    contractPath = await persistContractById(sharedContract, logger);
    trackingState.contract.path = contractPath; // 批② 迁树:tracker 绑定发生在正本落位之后,path=正本树内定址
    await writeFile(join(inboxDir, "contract.json"), JSON.stringify(sharedContract, null, 2), "utf8");
    await writeFile(reportPath, "# Protocol Commit Report\n\nworker finished without natural agent_end\n", "utf8");
    await writeFile(join(outboxDir, "runtime_result.json"), JSON.stringify({
      version: 1,
      stage: workerId,
      status: "completed",
      summary: "worker stage completed",
      feedback: "runtime_result is the authoritative completion signal",
      completion: {
        status: "completed",
      },
    }, null, 2), "utf8");

    rememberTrackingState(sessionKey, trackingState);
    openSessionProgress(sessionKey, trackingState.contract);

    const afterToolCall = getHandler("after_tool_call");
    await afterToolCall({
      toolName: "Write",
      params: {
        path: "outbox/runtime_result.json",
      },
    }, {
      sessionKey,
      agentId: workerId,
    });

    await new Promise((resolve) => setTimeout(resolve, 800));

    const persisted = JSON.parse(await readFile(contractPath, "utf8"));
    assert.equal(
      persisted.status,
      CONTRACT_STATUS.COMPLETED,
      "canonical outbox commit should finalize the shared contract even without agent_end",
    );
    assert.ok(
      taskHistory.some((entry) => entry.sessionKey === sessionKey && entry.status === CONTRACT_STATUS.COMPLETED),
      "protocol commit reconciliation should emit a terminal track_end history record",
    );
    assert.equal(
      await readFile(finalOutputPath, "utf8"),
      await readFile(join(controllerOutputDir, reportName), "utf8"),
      "primary artifact should be mirrored into the contract output path",
    );
  } finally {
    taskHistory.length = originalTaskHistoryLength;
    clearProtocolCommitReconcileState();
    clearTrackingStore();
    clearAllSessionProgress();
    runtimeAgentConfigs.clear();
    await unlink(contractPath).catch(() => {});
    await unlink(finalOutputPath).catch(() => {});
    await unlink(join(controllerOutputDir, reportName)).catch(() => {});
    await rm(workspaceDir, { recursive: true, force: true });
    await rm(join(OC, "workspaces", plannerId), { recursive: true, force: true });
  }
});

test("planner inbox reads schedule no deletion — the envelope survives to agent_end cleanup", async () => {
  // 清道夫拆除锁(2026-08-18):planner inbox .json 读后 10s 定时删已随 v4 遗留一并拆除。
  // 它按墙钟删、与 turn 生命周期无关,会在 agent_end 快照之前把信封删空(读面"系统输入
  // 不可考")、让 hard-path autoexec 随 turn 时长静默失效,并给信封缺席竞态添火;职责本就
  // 由 cleanInbox 严格覆盖(整目录 + ownerContractId 归属守卫 + 摘链 + direct 晋位)。
  // 本锁盯的是"读 planner inbox 不再安排任何延时删除",信封留到收尾由 cleanInbox 收口。
  const plannerId = `planner-inbox-no-scavenger-${Date.now()}`;
  const workerId = `worker-inbox-no-scavenger-${Date.now()}`;
  const workspaceDir = join(OC, "workspaces", plannerId);
  const inboxDir = join(workspaceDir, "inbox");
  const inboxContractPath = join(inboxDir, "contract.json");
  const sessionKey = `agent:${plannerId}:contract:no-scavenger`;
  const scheduledDelays = [];
  const originalSetTimeout = global.setTimeout;

  registerRuntimeAgents(buildRuntimeConfig({ plannerId, workerId }));
  clearTrackingStore();

  try {
    await mkdir(inboxDir, { recursive: true });
    await writeFile(inboxContractPath, JSON.stringify({ id: "TC-no-scavenger", assignee: plannerId }), "utf8");

    global.setTimeout = (fn, delay, ...rest) => {
      scheduledDelays.push(delay);
      return originalSetTimeout(() => {}, 0, ...rest); // 只观察是否被安排,不执行回调
    };

    const { api, getHandler } = createHookApi();
    afterToolCallHook.register(api, logger);
    await getHandler("after_tool_call")(
      { toolName: "read", params: { file_path: inboxContractPath }, result: { content: [{ type: "text", text: "{}" }] } },
      { agentId: plannerId, sessionKey },
    );

    assert.deepEqual(scheduledDelays, [], "读 planner inbox 不得安排任何延时删除");
    await assert.doesNotReject(readFile(inboxContractPath, "utf8"), "信封必须留到 agent_end 收尾");
  } finally {
    global.setTimeout = originalSetTimeout;
    runtimeAgentConfigs.clear();
    clearTrackingStore();
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("canonical outbox commit follows workspace symlink aliases used by real worker sessions", async () => {
  const plannerId = `planner-proto-link-${Date.now()}`;
  const workerId = `worker-proto-link-${Date.now()}`;
  const workspaceDir = join(OC, "workspaces", workerId);
  const inboxDir = join(workspaceDir, "inbox");
  const outboxDir = join(workspaceDir, "outbox");
  const controllerOutputDir = join(OC, "control-plane", "output");
  const reportName = `protocol-link-${Date.now()}.md`;
  const reportPath = join(outboxDir, reportName);
  const contractId = `TC-PROTOCOL-LINK-${Date.now()}`;
  let contractPath = getContractPath(contractId);
  const finalOutputPath = join(controllerOutputDir, `${contractId}.md`);
  const sessionKey = `agent:${workerId}:protocol-commit-link`;
  const originalTaskHistoryLength = taskHistory.length;
  const aliasedWorkspaceDir = join(OC, `workspace-${workerId}`);
  const aliasedStageResultPath = join(aliasedWorkspaceDir, "outbox", "runtime_result.json");

  registerRuntimeAgents(buildRuntimeConfig({ plannerId, workerId }));
  clearTrackingStore();
  clearAllSessionProgress();

  await mkdir(inboxDir, { recursive: true });
  await mkdir(outboxDir, { recursive: true });
  await mkdir(controllerOutputDir, { recursive: true });
  await symlink(join("workspaces", workerId), aliasedWorkspaceDir).catch((error) => {
    if (error?.code !== "EEXIST") throw error;
  });

  const sharedContract = {
    id: contractId,
    task: "protocol symlink alias regression",
    assignee: workerId,
    replyTo: {
      agentId: "controller",
      sessionKey: "agent:controller:main",
    },
    phases: ["分析", "写报告"],
    total: 2,
    output: finalOutputPath,
    status: CONTRACT_STATUS.RUNNING,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    protocol: {
      version: 1,
      envelope: "execution_contract",
      transport: "contracts/*.json",
      source: "test",
    },
  };

  const trackingState = createTrackingState({
    sessionKey,
    agentId: workerId,
    parentSession: null,
  });
  trackingState.contract = {
    ...sharedContract,
    path: contractPath,
  };

  const { api, getHandler } = createHookApi();
  afterToolCallHook.register(api, logger, {
    wakeContractor: async () => null,
  });

  try {
    contractPath = await persistContractById(sharedContract, logger);
    trackingState.contract.path = contractPath; // 批② 迁树:tracker 绑定发生在正本落位之后,path=正本树内定址
    await writeFile(join(inboxDir, "contract.json"), JSON.stringify(sharedContract, null, 2), "utf8");
    await writeFile(reportPath, "# Protocol Commit Report\n\nworker finished via aliased workspace path\n", "utf8");
    await writeFile(join(outboxDir, "runtime_result.json"), JSON.stringify({
      version: 1,
      stage: workerId,
      status: "completed",
      summary: "worker stage completed via alias",
      feedback: "symlinked workspace path should still reconcile",
      completion: {
        status: "completed",
      },
    }, null, 2), "utf8");

    rememberTrackingState(sessionKey, trackingState);
    openSessionProgress(sessionKey, trackingState.contract);

    const afterToolCall = getHandler("after_tool_call");
    await afterToolCall({
      toolName: "Write",
      params: {
        path: aliasedStageResultPath,
      },
    }, {
      sessionKey,
      agentId: workerId,
    });

    await new Promise((resolve) => setTimeout(resolve, 800));

    const persisted = JSON.parse(await readFile(contractPath, "utf8"));
    assert.equal(
      persisted.status,
      CONTRACT_STATUS.COMPLETED,
      "aliased workspace path should still finalize the shared contract",
    );
  } finally {
    taskHistory.length = originalTaskHistoryLength;
    clearProtocolCommitReconcileState();
    clearTrackingStore();
    clearAllSessionProgress();
    runtimeAgentConfigs.clear();
    await unlink(aliasedWorkspaceDir).catch(() => {});
    await unlink(contractPath).catch(() => {});
    await unlink(finalOutputPath).catch(() => {});
    await unlink(join(controllerOutputDir, reportName)).catch(() => {});
    await rm(workspaceDir, { recursive: true, force: true });
    await rm(join(OC, "workspaces", plannerId), { recursive: true, force: true });
  }
});

test("loop hard stop requires runtime_result instead of completing from contract.output", async () => {
  const plannerId = `planner-loop-stop-${Date.now()}`;
  const workerId = `worker-loop-stop-${Date.now()}`;
  const workspaceDir = join(OC, "workspaces", workerId);
  const inboxDir = join(workspaceDir, "inbox");
  const controllerOutputDir = join(OC, "control-plane", "output");
  const contractId = `TC-LOOP-STOP-${Date.now()}`;
  let contractPath = getContractPath(contractId);
  const finalOutputPath = join(controllerOutputDir, `${contractId}.md`);
  const sessionKey = `agent:${workerId}:loop-stop`;
  const originalTaskHistoryLength = taskHistory.length;

  registerRuntimeAgents(buildRuntimeConfig({ plannerId, workerId }));
  clearTrackingStore();
  clearAllSessionProgress();

  await mkdir(inboxDir, { recursive: true });
  await mkdir(controllerOutputDir, { recursive: true });

  const sharedContract = {
    id: contractId,
    task: "loop stop output reconcile regression",
    assignee: workerId,
    replyTo: {
      agentId: "controller",
      sessionKey: "agent:controller:main",
    },
    phases: ["执行"],
    total: 1,
    output: finalOutputPath,
    status: CONTRACT_STATUS.RUNNING,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    protocol: {
      version: 1,
      envelope: "execution_contract",
      transport: "contracts/*.json",
      source: "test",
    },
  };

  const trackingState = createTrackingState({
    sessionKey,
    agentId: workerId,
    parentSession: null,
  });
  trackingState.contract = {
    ...sharedContract,
    path: contractPath,
  };

  const { api, getHandler } = createHookApi();
  afterToolCallHook.register(api, logger);

  try {
    contractPath = await persistContractById(sharedContract, logger);
    trackingState.contract.path = contractPath; // 批② 迁树:tracker 绑定发生在正本落位之后,path=正本树内定址
    await writeFile(join(inboxDir, "contract.json"), JSON.stringify(sharedContract, null, 2), "utf8");
    await writeFile(finalOutputPath, "6:41 AM (Asia/Shanghai)\n", "utf8");

    rememberTrackingState(sessionKey, trackingState);
    openSessionProgress(sessionKey, trackingState.contract);

    const afterToolCall = getHandler("after_tool_call");
    for (let index = 0; index < 5; index += 1) {
      await afterToolCall({
        toolName: "Write",
        params: {
          path: finalOutputPath,
        },
      }, {
        sessionKey,
        agentId: workerId,
      });
    }

    await new Promise((resolve) => setTimeout(resolve, 800));

    const persisted = JSON.parse(await readFile(contractPath, "utf8"));
    assert.equal(
      persisted.status,
      CONTRACT_STATUS.FAILED,
      "contract.output alone must not complete a hard-stopped session",
    );
    assert.equal(
      persisted.terminalOutcome?.status,
      CONTRACT_STATUS.FAILED,
      "synthetic terminal reconcile should persist a failed protocol outcome",
    );
    assert.ok(
      taskHistory.some((entry) => entry.sessionKey === sessionKey && entry.status === CONTRACT_STATUS.FAILED),
      "loop hard stop reconcile should emit a terminal track_end history record",
    );
  } finally {
    taskHistory.length = originalTaskHistoryLength;
    clearProtocolCommitReconcileState();
    clearTrackingStore();
    clearAllSessionProgress();
    runtimeAgentConfigs.clear();
    await unlink(contractPath).catch(() => {});
    await unlink(finalOutputPath).catch(() => {});
    await rm(workspaceDir, { recursive: true, force: true });
    await rm(join(OC, "workspaces", plannerId), { recursive: true, force: true });
  }
});

test("loop hard stop after output commit keeps following graph topology", async () => {
  const suffix = Date.now();
  const plannerId = `planner-loop-route-${suffix}`;
  const workerId = `worker-loop-route-${suffix}`;
  const worker2Id = `worker2-loop-route-${suffix}`;
  const workspaceDir = join(OC, "workspaces", workerId);
  const worker2WorkspaceDir = join(OC, "workspaces", worker2Id);
  const inboxDir = join(workspaceDir, "inbox");
  const controllerOutputDir = join(OC, "control-plane", "output");
  const contractId = `TC-LOOP-ROUTE-${suffix}`;
  let contractPath = getContractPath(contractId);
  const finalOutputPath = join(controllerOutputDir, `${contractId}.md`);
  const sessionKey = `agent:${workerId}:loop-route`;
  const originalTaskHistoryLength = taskHistory.length;
  const originalGraph = await loadGraph();

  registerRuntimeAgents(buildRuntimeConfig({ plannerId, workerId, worker2Id }));
  clearTrackingStore();
  clearAllSessionProgress();
  clearAllSessions();
  resetAllDispatchStates();
  clearDispatchQueue();

  await mkdir(inboxDir, { recursive: true });
  await mkdir(worker2WorkspaceDir, { recursive: true });
  await mkdir(controllerOutputDir, { recursive: true });
  await saveGraph({
    edges: [
      ...originalGraph.edges,
      { from: workerId, to: worker2Id },
    ],
  });
  await syncDispatchTargetsFromRuntime(logger);
  await claimDispatchTargetContract({
    contractId: `OTHER-${contractId}`,
    agentId: worker2Id,
    logger,
  });

  const sharedContract = {
    id: contractId,
    task: "graph route after committed output loop stop",
    assignee: workerId,
    replyTo: {
      agentId: "controller",
      sessionKey: "agent:controller:main",
    },
    phases: ["执行"],
    total: 1,
    output: finalOutputPath,
    status: CONTRACT_STATUS.RUNNING,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    protocol: {
      version: 1,
      envelope: "execution_contract",
      transport: "contracts/*.json",
      source: "test",
    },
  };

  const trackingState = createTrackingState({
    sessionKey,
    agentId: workerId,
    parentSession: null,
  });
  trackingState.contract = {
    ...sharedContract,
    path: contractPath,
  };

  const { api, getHandler } = createHookApi();
  afterToolCallHook.register(api, logger);

  try {
    contractPath = await persistContractById(sharedContract, logger);
    trackingState.contract.path = contractPath; // 批② 迁树:tracker 绑定发生在正本落位之后,path=正本树内定址
    await writeFile(join(inboxDir, "contract.json"), JSON.stringify(sharedContract, null, 2), "utf8");
    await writeFile(finalOutputPath, "Monday, April 27th, 2026\n", "utf8");

    rememberTrackingState(sessionKey, trackingState);
    openSessionProgress(sessionKey, trackingState.contract);

    const afterToolCall = getHandler("after_tool_call");
    for (let index = 0; index < 5; index += 1) {
      await afterToolCall({
        toolName: "Write",
        params: {
          path: finalOutputPath,
          content: "Monday, April 27th, 2026\n",
        },
      }, {
        sessionKey,
        agentId: workerId,
      });
    }

    await new Promise((resolve) => setTimeout(resolve, 800));

    const persisted = JSON.parse(await readFile(contractPath, "utf8"));
    assert.notEqual(
      persisted.status,
      CONTRACT_STATUS.FAILED,
      "committed output plus graph edge should keep routing instead of failing the contract",
    );
    assert.equal(persisted.assignee, worker2Id);
    assert.equal(getDispatchQueueDepth(worker2Id), 1);
    assert.equal(
      persisted.terminalOutcome || null,
      null,
      "graph-routed contracts should not gain a terminal hard-stop outcome at the intermediate node",
    );
  } finally {
    taskHistory.length = originalTaskHistoryLength;
    clearProtocolCommitReconcileState();
    clearTrackingStore();
    clearAllSessionProgress();
    clearAllSessions();
    clearDispatchQueue();
    resetAllDispatchStates();
    await releaseDispatchTargetContract({ agentId: worker2Id, logger }).catch(() => {});
    runtimeAgentConfigs.clear();
    await saveGraph(originalGraph);
    await unlink(contractPath).catch(() => {});
    await unlink(finalOutputPath).catch(() => {});
    await rm(workspaceDir, { recursive: true, force: true });
    await rm(worker2WorkspaceDir, { recursive: true, force: true });
    await rm(join(OC, "workspaces", plannerId), { recursive: true, force: true });
  }
});

test("loop hard stop terminalizes a running contract even when no output artifact was committed", async () => {
  const plannerId = `planner-proto-loop-fail-${Date.now()}`;
  const workerId = `worker-proto-loop-fail-${Date.now()}`;
  const workspaceDir = join(OC, "workspaces", workerId);
  const inboxDir = join(workspaceDir, "inbox");
  const controllerOutputDir = join(OC, "control-plane", "output");
  const contractId = `TC-PROTOCOL-LOOP-FAIL-${Date.now()}`;
  let contractPath = getContractPath(contractId);
  const finalOutputPath = join(controllerOutputDir, `${contractId}.md`);
  const sessionKey = `agent:${workerId}:protocol-loop-fail`;
  const originalTaskHistoryLength = taskHistory.length;

  registerRuntimeAgents(buildRuntimeConfig({ plannerId, workerId }));
  clearTrackingStore();
  clearAllSessionProgress();
  clearAllSessions();

  await mkdir(inboxDir, { recursive: true });
  await mkdir(controllerOutputDir, { recursive: true });

  const sharedContract = {
    id: contractId,
    task: "loop hard stop should fail the contract without waiting for outer timeout",
    assignee: workerId,
    replyTo: {
      agentId: "controller",
      sessionKey: "agent:controller:main",
    },
    phases: ["执行"],
    total: 1,
    output: finalOutputPath,
    status: CONTRACT_STATUS.RUNNING,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    protocol: {
      version: 1,
      envelope: "execution_contract",
      transport: "contracts/*.json",
      source: "test",
    },
  };

  const trackingState = createTrackingState({
    sessionKey,
    agentId: workerId,
    parentSession: null,
  });
  trackingState.contract = {
    ...sharedContract,
    path: contractPath,
  };

  const { api, getHandler } = createHookApi();
  afterToolCallHook.register(api, logger);

  try {
    contractPath = await persistContractById(sharedContract, logger);
    trackingState.contract.path = contractPath; // 批② 迁树:tracker 绑定发生在正本落位之后,path=正本树内定址
    await writeFile(join(inboxDir, "contract.json"), JSON.stringify(sharedContract, null, 2), "utf8");

    rememberTrackingState(sessionKey, trackingState);
    openSessionProgress(sessionKey, trackingState.contract);
    await syncDispatchTargetsFromRuntime(logger);
    await claimDispatchTargetContract({ contractId, agentId: workerId, logger });
    assert.equal(isDispatchTargetBusy(workerId), true);

    const afterToolCall = getHandler("after_tool_call");
    for (let index = 0; index < 5; index += 1) {
      await afterToolCall({
        toolName: "Read",
        params: {
          path: "inbox/contract.json",
        },
      }, {
        sessionKey,
        agentId: workerId,
      });
    }

    const persisted = JSON.parse(await readFile(contractPath, "utf8"));
    assert.equal(
      persisted.status,
      CONTRACT_STATUS.FAILED,
      "loop hard stop should terminalize synchronously without waiting for agent_end or reconcile timers",
    );
    assert.equal(
      persisted.terminalOutcome?.status,
      CONTRACT_STATUS.FAILED,
      "synthetic terminal reconcile should persist a failed terminal outcome after loop hard stop",
    );
    assert.match(
      persisted.terminalOutcome?.reason || "",
      /identical_tool_loop|loop_detected|missing_file|no semantic output detected/u,
      "terminal outcome should capture the loop-stop failure instead of leaving the contract running",
    );
    assert.ok(
      taskHistory.some((entry) => entry.sessionKey === sessionKey && entry.status === CONTRACT_STATUS.FAILED),
      "loop hard stop failure should emit a terminal track_end history record",
    );
    assert.equal(
      isDispatchTargetBusy(workerId),
      false,
      "loop hard stop should release dispatch runtime ownership immediately",
    );
  } finally {
    taskHistory.length = originalTaskHistoryLength;
    clearProtocolCommitReconcileState();
    clearTrackingStore();
    clearAllSessionProgress();
    clearAllSessions();
    runtimeAgentConfigs.clear();
    await unlink(contractPath).catch(() => {});
    await unlink(finalOutputPath).catch(() => {});
    await rm(workspaceDir, { recursive: true, force: true });
    await rm(join(OC, "workspaces", plannerId), { recursive: true, force: true });
  }
});

test("canonical outbox commit recognizes workspace symlink alias paths before the target file exists", async () => {
  const plannerId = `planner-proto-prewrite-${Date.now()}`;
  const workerId = `worker-proto-prewrite-${Date.now()}`;
  const workspaceDir = join(OC, "workspaces", workerId);
  const outboxDir = join(workspaceDir, "outbox");
  const aliasedWorkspaceDir = join(OC, `workspace-${workerId}`);
  const aliasedStageResultPath = join(aliasedWorkspaceDir, "outbox", "runtime_result.json");

  registerRuntimeAgents(buildRuntimeConfig({ plannerId, workerId }));
  clearTrackingStore();
  clearAllSessionProgress();

  await mkdir(outboxDir, { recursive: true });
  await symlink(join("workspaces", workerId), aliasedWorkspaceDir).catch((error) => {
    if (error?.code !== "EEXIST") throw error;
  });

  try {
    const commitInfo = await classifyCanonicalProtocolCommit({
      agentId: workerId,
      targetPath: aliasedStageResultPath,
    });

    assert.deepEqual(commitInfo, {
      type: "runtime_result",
      fileName: "runtime_result.json",
      commitPath: join(outboxDir, "runtime_result.json"),
    });
  } finally {
    clearProtocolCommitReconcileState();
    clearTrackingStore();
    clearAllSessionProgress();
    runtimeAgentConfigs.clear();
    await unlink(aliasedWorkspaceDir).catch(() => {});
    await rm(workspaceDir, { recursive: true, force: true });
    await rm(join(OC, "workspaces", plannerId), { recursive: true, force: true });
  }
});

test("canonical outbox commit does not recognize legacy stage_result files", async () => {
  const plannerId = `planner-proto-legacy-stage-${Date.now()}`;
  const workerId = `worker-proto-legacy-stage-${Date.now()}`;
  const workspaceDir = join(OC, "workspaces", workerId);
  const outboxDir = join(workspaceDir, "outbox");

  registerRuntimeAgents(buildRuntimeConfig({ plannerId, workerId }));
  clearTrackingStore();
  clearAllSessionProgress();

  await mkdir(outboxDir, { recursive: true });

  try {
    const commitInfo = await classifyCanonicalProtocolCommit({
      agentId: workerId,
      targetPath: join(outboxDir, "stage_result.json"),
    });

    assert.equal(commitInfo, null);
  } finally {
    clearProtocolCommitReconcileState();
    clearTrackingStore();
    clearAllSessionProgress();
    runtimeAgentConfigs.clear();
    await rm(workspaceDir, { recursive: true, force: true });
    await rm(join(OC, "workspaces", plannerId), { recursive: true, force: true });
  }
});

test("canonical outbox commit ignores stale runtime_result artifact inventory and finalizes from actual outbox files", async () => {
  const plannerId = `planner-proto-inventory-${Date.now()}`;
  const workerId = `worker-proto-inventory-${Date.now()}`;
  const workspaceDir = join(OC, "workspaces", workerId);
  const inboxDir = join(workspaceDir, "inbox");
  const outboxDir = join(workspaceDir, "outbox");
  const controllerOutputDir = join(OC, "control-plane", "output");
  const reportName = `protocol-inventory-${Date.now()}.md`;
  const reportPath = join(outboxDir, reportName);
  const contractId = `TC-PROTOCOL-INVENTORY-${Date.now()}`;
  let contractPath = getContractPath(contractId);
  const finalOutputPath = join(controllerOutputDir, `${contractId}.md`);
  const sessionKey = `agent:${workerId}:protocol-commit-inventory`;
  const originalTaskHistoryLength = taskHistory.length;

  registerRuntimeAgents(buildRuntimeConfig({ plannerId, workerId }));
  clearTrackingStore();
  clearAllSessionProgress();

  await mkdir(inboxDir, { recursive: true });
  await mkdir(outboxDir, { recursive: true });
  await mkdir(controllerOutputDir, { recursive: true });

  const sharedContract = {
    id: contractId,
    task: "protocol commit artifact ordering regression",
    assignee: workerId,
    replyTo: {
      agentId: "controller",
      sessionKey: "agent:controller:main",
    },
    phases: ["分析", "写报告"],
    total: 2,
    output: finalOutputPath,
    status: CONTRACT_STATUS.RUNNING,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    protocol: {
      version: 1,
      envelope: "execution_contract",
      transport: "contracts/*.json",
      source: "test",
    },
  };

  const trackingState = createTrackingState({
    sessionKey,
    agentId: workerId,
    parentSession: null,
  });
  trackingState.contract = {
    ...sharedContract,
    path: contractPath,
  };

  const { api, getHandler } = createHookApi();
  afterToolCallHook.register(api, logger, {
    wakeContractor: async () => null,
  });

  try {
    contractPath = await persistContractById(sharedContract, logger);
    trackingState.contract.path = contractPath; // 批② 迁树:tracker 绑定发生在正本落位之后,path=正本树内定址
    await writeFile(join(inboxDir, "contract.json"), JSON.stringify(sharedContract, null, 2), "utf8");
    await writeFile(reportPath, "# Protocol Commit Report\n\nactual outbox artifact already exists\n", "utf8");
    await writeFile(join(outboxDir, "runtime_result.json"), JSON.stringify({
      version: 1,
      stage: workerId,
      status: "completed",
      summary: "worker stage completed with stale artifact inventory",
      feedback: "runtime should trust actual outbox files instead of legacy artifact declarations",
      artifacts: [
        { type: "text_output", path: "never-materialized.md", label: "stale legacy artifact", required: true },
      ],
      primaryArtifactPath: "never-materialized.md",
      completion: {
        status: "completed",
      },
    }, null, 2), "utf8");

    rememberTrackingState(sessionKey, trackingState);
    openSessionProgress(sessionKey, trackingState.contract);

    const afterToolCall = getHandler("after_tool_call");
    await afterToolCall({
      toolName: "Write",
      params: {
        path: "outbox/runtime_result.json",
      },
    }, {
      sessionKey,
      agentId: workerId,
    });

    await new Promise((resolve) => setTimeout(resolve, 800));

    const persisted = JSON.parse(await readFile(contractPath, "utf8"));
    assert.equal(
      persisted.status,
      CONTRACT_STATUS.COMPLETED,
      "contract should finalize from the actual outbox sweep even when runtime_result carries stale artifact inventory",
    );
    assert.equal(
      trackingState.status,
      CONTRACT_STATUS.COMPLETED,
      "tracking state should not stay running just because a stale artifact declaration points to a missing file",
    );
    assert.equal(
      await readFile(finalOutputPath, "utf8"),
      await readFile(join(controllerOutputDir, reportName), "utf8"),
      "primary artifact should still be mirrored after delayed materialization",
    );
  } finally {
    taskHistory.length = originalTaskHistoryLength;
    clearProtocolCommitReconcileState();
    clearTrackingStore();
    clearAllSessionProgress();
    runtimeAgentConfigs.clear();
    await unlink(contractPath).catch(() => {});
    await unlink(finalOutputPath).catch(() => {});
    await unlink(join(controllerOutputDir, reportName)).catch(() => {});
    await rm(workspaceDir, { recursive: true, force: true });
    await rm(join(OC, "workspaces", plannerId), { recursive: true, force: true });
  }
});

test("canonical outbox commit is observed even when the tool event has no writable path metadata", async () => {
  const plannerId = `planner-proto-probe-${Date.now()}`;
  const workerId = `worker-proto-probe-${Date.now()}`;
  const workspaceDir = join(OC, "workspaces", workerId);
  const inboxDir = join(workspaceDir, "inbox");
  const outboxDir = join(workspaceDir, "outbox");
  const controllerOutputDir = join(OC, "control-plane", "output");
  const reportName = `protocol-probe-${Date.now()}.md`;
  const reportPath = join(outboxDir, reportName);
  const contractId = `TC-PROTOCOL-PROBE-${Date.now()}`;
  let contractPath = getContractPath(contractId);
  const finalOutputPath = join(controllerOutputDir, `${contractId}.md`);
  const sessionKey = `agent:${workerId}:protocol-commit-probe`;
  const originalTaskHistoryLength = taskHistory.length;

  registerRuntimeAgents(buildRuntimeConfig({ plannerId, workerId }));
  clearTrackingStore();
  clearAllSessionProgress();

  await mkdir(inboxDir, { recursive: true });
  await mkdir(outboxDir, { recursive: true });
  await mkdir(controllerOutputDir, { recursive: true });

  const sharedContract = {
    id: contractId,
    task: "protocol commit should be observed without writable path metadata",
    assignee: workerId,
    replyTo: {
      agentId: "controller",
      sessionKey: "agent:controller:main",
    },
    phases: ["分析", "写报告"],
    total: 2,
    output: finalOutputPath,
    status: CONTRACT_STATUS.RUNNING,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    protocol: {
      version: 1,
      envelope: "execution_contract",
      transport: "contracts/*.json",
      source: "test",
    },
  };

  const trackingState = createTrackingState({
    sessionKey,
    agentId: workerId,
    parentSession: null,
  });
  trackingState.contract = {
    ...sharedContract,
    path: contractPath,
  };

  const { api, getHandler } = createHookApi();
  afterToolCallHook.register(api, logger, {
    wakeContractor: async () => null,
  });

  try {
    contractPath = await persistContractById(sharedContract, logger);
    trackingState.contract.path = contractPath; // 批② 迁树:tracker 绑定发生在正本落位之后,path=正本树内定址
    await writeFile(join(inboxDir, "contract.json"), JSON.stringify(sharedContract, null, 2), "utf8");
    await writeFile(reportPath, "# Protocol Commit Report\n\nobserved without writable path metadata\n", "utf8");
    await writeFile(join(outboxDir, "runtime_result.json"), JSON.stringify({
      version: 1,
      stage: workerId,
      status: "completed",
      summary: "worker stage completed via runtime_result probe",
      feedback: "runtime_result probe should reconcile even for shell-like tools",
      completion: {
        status: "completed",
      },
    }, null, 2), "utf8");

    rememberTrackingState(sessionKey, trackingState);
    openSessionProgress(sessionKey, trackingState.contract);

    const afterToolCall = getHandler("after_tool_call");
    await afterToolCall({
      toolName: "Bash",
      params: {
        command: "printf 'done\\n'",
      },
    }, {
      sessionKey,
      agentId: workerId,
    });

    await new Promise((resolve) => setTimeout(resolve, 800));

    const persisted = JSON.parse(await readFile(contractPath, "utf8"));
    assert.equal(
      persisted.status,
      CONTRACT_STATUS.COMPLETED,
      "runtime_result probe should finalize the shared contract even when tool metadata lacks a path",
    );
    assert.ok(
      taskHistory.some((entry) => entry.sessionKey === sessionKey && entry.status === CONTRACT_STATUS.COMPLETED),
      "runtime_result probe should still emit a terminal track_end history record",
    );
  } finally {
    taskHistory.length = originalTaskHistoryLength;
    clearProtocolCommitReconcileState();
    clearTrackingStore();
    clearAllSessionProgress();
    runtimeAgentConfigs.clear();
    await unlink(contractPath).catch(() => {});
    await unlink(finalOutputPath).catch(() => {});
    await unlink(join(controllerOutputDir, reportName)).catch(() => {});
    await rm(workspaceDir, { recursive: true, force: true });
    await rm(join(OC, "workspaces", plannerId), { recursive: true, force: true });
  }
});

test("output_commit stays observational and does not finalize or release planner reservation", async () => {
  const plannerId = `planner-proto-tail-${Date.now()}`;
  const workerId = `worker-proto-tail-${Date.now()}`;
  const workspaceDir = join(OC, "workspaces", plannerId);
  const inboxDir = join(workspaceDir, "inbox");
  const outboxDir = join(workspaceDir, "outbox");
  const controllerOutputDir = join(OC, "control-plane", "output");
  const reportName = `protocol-tail-${Date.now()}.md`;
  const reportPath = join(outboxDir, reportName);
  const contractId = `TC-PROTOCOL-TAIL-${Date.now()}`;
  let contractPath = getContractPath(contractId);
  const finalOutputPath = join(controllerOutputDir, `${contractId}.md`);
  const sessionKey = `agent:${plannerId}:contract:${contractId}`;
  const originalTaskHistoryLength = taskHistory.length;

  registerRuntimeAgents(buildRuntimeConfig({ plannerId, workerId }));
  clearTrackingStore();
  clearAllSessionProgress();

  await mkdir(inboxDir, { recursive: true });
  await mkdir(outboxDir, { recursive: true });
  await mkdir(controllerOutputDir, { recursive: true });
  await syncDispatchTargetsFromRuntime(logger);

  const sharedContract = {
    id: contractId,
    task: "protocol commit should not free planner reservation immediately",
    assignee: plannerId,
    replyTo: {
      agentId: "controller",
      sessionKey: "agent:controller:main",
    },
    phases: ["分析", "写报告"],
    total: 2,
    output: finalOutputPath,
    status: CONTRACT_STATUS.RUNNING,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    protocol: {
      version: 1,
      envelope: "execution_contract",
      transport: "contracts/*.json",
      source: "test",
    },
  };

  const trackingState = createTrackingState({
    sessionKey,
    agentId: plannerId,
    parentSession: null,
  });
  trackingState.contract = {
    ...sharedContract,
    path: contractPath,
  };

  const { api, getHandler } = createHookApi();
  afterToolCallHook.register(api, logger, {
    wakeContractor: async () => null,
  });

  try {
    contractPath = await persistContractById(sharedContract, logger);
    trackingState.contract.path = contractPath; // 批② 迁树:tracker 绑定发生在正本落位之后,path=正本树内定址
    await writeFile(join(inboxDir, "contract.json"), JSON.stringify(sharedContract, null, 2), "utf8");
    await writeFile(finalOutputPath, "# Planner Protocol Commit\n\nplanner finished logical work before natural agent_end\n", "utf8");

    rememberTrackingState(sessionKey, trackingState);
    openSessionProgress(sessionKey, trackingState.contract);
    await claimDispatchTargetContract({ contractId, agentId: plannerId, logger });

    const afterToolCall = getHandler("after_tool_call");
    await afterToolCall({
      toolName: "Write",
      params: {
        path: finalOutputPath,
      },
    }, {
      sessionKey,
      agentId: plannerId,
    });

    await new Promise((resolve) => setTimeout(resolve, 800));

    const persisted = JSON.parse(await readFile(contractPath, "utf8"));
    assert.equal(
      persisted.status,
      CONTRACT_STATUS.RUNNING,
      "writing contract.output must stay observational and must not finalize the shared contract",
    );
    assert.equal(
      isDispatchTargetBusy(plannerId),
      true,
      "observing contract.output must not release the planner reservation",
    );

    const flushResult = await flushProtocolCommitDeferredRelease(sessionKey);
    assert.equal(
      flushResult?.reason,
      "deferred_release_missing",
      "output_commit should not arm deferred dispatch release",
    );
    assert.equal(
      isDispatchTargetBusy(plannerId),
      true,
      "planner reservation must still be held because no real agent_end happened",
    );
  } finally {
    taskHistory.length = originalTaskHistoryLength;
    clearProtocolCommitReconcileState();
    clearTrackingStore();
    clearAllSessionProgress();
    runtimeAgentConfigs.clear();
    await unlink(contractPath).catch(() => {});
    await unlink(finalOutputPath).catch(() => {});
    await unlink(join(controllerOutputDir, reportName)).catch(() => {});
    await rm(workspaceDir, { recursive: true, force: true });
    await rm(join(OC, "workspaces", workerId), { recursive: true, force: true });
  }
});
