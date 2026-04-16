import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import * as afterToolCallHook from "../hooks/after-tool-call.js";
import { registerRuntimeAgents } from "../lib/agent/agent-identity.js";
import { persistContractSnapshot, getContractPath } from "../lib/contracts.js";
import { clearAllTraces, initTrace } from "../lib/store/execution-trace-store.js";
import { createTrackingState } from "../lib/session-bootstrap.js";
import { CONTRACT_STATUS } from "../lib/core/runtime-status.js";
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
} from "../lib/protocol-commit-reconcile.js";
import {
  clearTrackingStore,
  rememberTrackingState,
} from "../lib/store/tracker-store.js";
import {
  claimDispatchTargetContract,
  isDispatchTargetBusy,
  syncDispatchTargetsFromRuntime,
} from "../lib/routing/dispatch-runtime-state.js";

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

function buildRuntimeConfig({ plannerId, workerId }) {
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
  const controllerOutputDir = join(OC, "workspaces", "controller", "output");
  const reportName = `protocol-commit-${Date.now()}.md`;
  const reportPath = join(outboxDir, reportName);
  const contractId = `TC-PROTOCOL-COMMIT-${Date.now()}`;
  const contractPath = getContractPath(contractId);
  const finalOutputPath = join(controllerOutputDir, `${contractId}.md`);
  const sessionKey = `agent:${workerId}:protocol-commit`;
  const originalTaskHistoryLength = taskHistory.length;

  registerRuntimeAgents(buildRuntimeConfig({ plannerId, workerId }));
  clearTrackingStore();
  clearAllTraces();

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
    enqueueFn: () => {},
    wakeContractor: async () => null,
  });

  try {
    await persistContractSnapshot(contractPath, sharedContract, logger);
    await writeFile(join(inboxDir, "contract.json"), JSON.stringify(sharedContract, null, 2), "utf8");
    await writeFile(join(outboxDir, "_manifest.json"), JSON.stringify({
      version: 1,
      kind: "execution_result",
      artifacts: [
        { type: "stage_result", path: "stage_result.json", required: true },
        { type: "text_output", path: reportName, required: true },
      ],
    }, null, 2), "utf8");
    await writeFile(reportPath, "# Protocol Commit Report\n\nworker finished without natural agent_end\n", "utf8");
    await writeFile(join(outboxDir, "stage_result.json"), JSON.stringify({
      version: 1,
      stage: workerId,
      status: "completed",
      summary: "worker stage completed",
      feedback: "stage_result is the authoritative completion signal",
      artifacts: [
        { type: "text_output", path: reportName, label: "report", required: true },
      ],
      primaryArtifactPath: reportName,
      completion: {
        status: "completed",
      },
    }, null, 2), "utf8");

    rememberTrackingState(sessionKey, trackingState);
    initTrace(sessionKey, trackingState.contract);

    const afterToolCall = getHandler("after_tool_call");
    await afterToolCall({
      toolName: "Write",
      params: {
        path: "outbox/stage_result.json",
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
    clearAllTraces();
    runtimeAgentConfigs.clear();
    await unlink(contractPath).catch(() => {});
    await unlink(finalOutputPath).catch(() => {});
    await unlink(join(controllerOutputDir, reportName)).catch(() => {});
    await rm(workspaceDir, { recursive: true, force: true });
    await rm(join(OC, "workspaces", plannerId), { recursive: true, force: true });
  }
});

test("canonical outbox commit follows workspace symlink aliases used by real worker sessions", async () => {
  const plannerId = `planner-proto-link-${Date.now()}`;
  const workerId = `worker-proto-link-${Date.now()}`;
  const workspaceDir = join(OC, "workspaces", workerId);
  const inboxDir = join(workspaceDir, "inbox");
  const outboxDir = join(workspaceDir, "outbox");
  const controllerOutputDir = join(OC, "workspaces", "controller", "output");
  const reportName = `protocol-link-${Date.now()}.md`;
  const reportPath = join(outboxDir, reportName);
  const contractId = `TC-PROTOCOL-LINK-${Date.now()}`;
  const contractPath = getContractPath(contractId);
  const finalOutputPath = join(controllerOutputDir, `${contractId}.md`);
  const sessionKey = `agent:${workerId}:protocol-commit-link`;
  const originalTaskHistoryLength = taskHistory.length;
  const aliasedWorkspaceDir = join(OC, `workspace-${workerId}`);
  const aliasedStageResultPath = join(aliasedWorkspaceDir, "outbox", "stage_result.json");

  registerRuntimeAgents(buildRuntimeConfig({ plannerId, workerId }));
  clearTrackingStore();
  clearAllTraces();

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
    enqueueFn: () => {},
    wakeContractor: async () => null,
  });

  try {
    await persistContractSnapshot(contractPath, sharedContract, logger);
    await writeFile(join(inboxDir, "contract.json"), JSON.stringify(sharedContract, null, 2), "utf8");
    await writeFile(join(outboxDir, "_manifest.json"), JSON.stringify({
      version: 1,
      kind: "execution_result",
      artifacts: [
        { type: "stage_result", path: "stage_result.json", required: true },
        { type: "text_output", path: reportName, required: true },
      ],
    }, null, 2), "utf8");
    await writeFile(reportPath, "# Protocol Commit Report\n\nworker finished via aliased workspace path\n", "utf8");
    await writeFile(join(outboxDir, "stage_result.json"), JSON.stringify({
      version: 1,
      stage: workerId,
      status: "completed",
      summary: "worker stage completed via alias",
      feedback: "symlinked workspace path should still reconcile",
      artifacts: [
        { type: "text_output", path: reportName, label: "report", required: true },
      ],
      primaryArtifactPath: reportName,
      completion: {
        status: "completed",
      },
    }, null, 2), "utf8");

    rememberTrackingState(sessionKey, trackingState);
    initTrace(sessionKey, trackingState.contract);

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
    clearAllTraces();
    runtimeAgentConfigs.clear();
    await unlink(aliasedWorkspaceDir).catch(() => {});
    await unlink(contractPath).catch(() => {});
    await unlink(finalOutputPath).catch(() => {});
    await unlink(join(controllerOutputDir, reportName)).catch(() => {});
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
  const aliasedStageResultPath = join(aliasedWorkspaceDir, "outbox", "stage_result.json");

  registerRuntimeAgents(buildRuntimeConfig({ plannerId, workerId }));
  clearTrackingStore();
  clearAllTraces();

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
      type: "stage_result",
      fileName: "stage_result.json",
      commitPath: join(outboxDir, "stage_result.json"),
    });
  } finally {
    clearProtocolCommitReconcileState();
    clearTrackingStore();
    clearAllTraces();
    runtimeAgentConfigs.clear();
    await unlink(aliasedWorkspaceDir).catch(() => {});
    await rm(workspaceDir, { recursive: true, force: true });
    await rm(join(OC, "workspaces", plannerId), { recursive: true, force: true });
  }
});

test("canonical outbox commit waits for referenced stage artifacts before finalizing", async () => {
  const plannerId = `planner-proto-artifact-${Date.now()}`;
  const workerId = `worker-proto-artifact-${Date.now()}`;
  const workspaceDir = join(OC, "workspaces", workerId);
  const inboxDir = join(workspaceDir, "inbox");
  const outboxDir = join(workspaceDir, "outbox");
  const controllerOutputDir = join(OC, "workspaces", "controller", "output");
  const reportName = `protocol-artifact-${Date.now()}.md`;
  const reportPath = join(outboxDir, reportName);
  const contractId = `TC-PROTOCOL-ARTIFACT-${Date.now()}`;
  const contractPath = getContractPath(contractId);
  const finalOutputPath = join(controllerOutputDir, `${contractId}.md`);
  const sessionKey = `agent:${workerId}:protocol-commit-artifact`;
  const originalTaskHistoryLength = taskHistory.length;

  registerRuntimeAgents(buildRuntimeConfig({ plannerId, workerId }));
  clearTrackingStore();
  clearAllTraces();

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
    enqueueFn: () => {},
    wakeContractor: async () => null,
  });

  try {
    await persistContractSnapshot(contractPath, sharedContract, logger);
    await writeFile(join(inboxDir, "contract.json"), JSON.stringify(sharedContract, null, 2), "utf8");
    await writeFile(join(outboxDir, "_manifest.json"), JSON.stringify({
      version: 1,
      kind: "execution_result",
      artifacts: [
        { type: "stage_result", path: "stage_result.json", required: true },
        { type: "text_output", path: reportName, required: true },
      ],
    }, null, 2), "utf8");
    await writeFile(join(outboxDir, "stage_result.json"), JSON.stringify({
      version: 1,
      stage: workerId,
      status: "completed",
      summary: "worker stage completed before artifact materialized",
      feedback: "stage_result references a report that is not written yet",
      artifacts: [
        { type: "text_output", path: reportName, label: "report", required: true },
      ],
      primaryArtifactPath: reportName,
      completion: {
        status: "completed",
      },
    }, null, 2), "utf8");

    rememberTrackingState(sessionKey, trackingState);
    initTrace(sessionKey, trackingState.contract);

    const afterToolCall = getHandler("after_tool_call");
    await afterToolCall({
      toolName: "Write",
      params: {
        path: "outbox/stage_result.json",
      },
    }, {
      sessionKey,
      agentId: workerId,
    });

    await new Promise((resolve) => setTimeout(resolve, 800));

    const stillRunning = JSON.parse(await readFile(contractPath, "utf8"));
    assert.equal(
      stillRunning.status,
      CONTRACT_STATUS.RUNNING,
      "contract should stay running while stage_result artifacts are still missing",
    );
    assert.equal(
      trackingState.status,
      CONTRACT_STATUS.RUNNING,
      "tracking state should not finalize before referenced artifacts exist",
    );

    await writeFile(reportPath, "# Protocol Commit Report\n\nartifact appeared after stage_result\n", "utf8");

    await new Promise((resolve) => setTimeout(resolve, 800));

    const persisted = JSON.parse(await readFile(contractPath, "utf8"));
    assert.equal(
      persisted.status,
      CONTRACT_STATUS.COMPLETED,
      "contract should finalize once the referenced artifact appears",
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
    clearAllTraces();
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
  const controllerOutputDir = join(OC, "workspaces", "controller", "output");
  const reportName = `protocol-probe-${Date.now()}.md`;
  const reportPath = join(outboxDir, reportName);
  const contractId = `TC-PROTOCOL-PROBE-${Date.now()}`;
  const contractPath = getContractPath(contractId);
  const finalOutputPath = join(controllerOutputDir, `${contractId}.md`);
  const sessionKey = `agent:${workerId}:protocol-commit-probe`;
  const originalTaskHistoryLength = taskHistory.length;

  registerRuntimeAgents(buildRuntimeConfig({ plannerId, workerId }));
  clearTrackingStore();
  clearAllTraces();

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
    enqueueFn: () => {},
    wakeContractor: async () => null,
  });

  try {
    await persistContractSnapshot(contractPath, sharedContract, logger);
    await writeFile(join(inboxDir, "contract.json"), JSON.stringify(sharedContract, null, 2), "utf8");
    await writeFile(join(outboxDir, "_manifest.json"), JSON.stringify({
      version: 1,
      kind: "execution_result",
      artifacts: [
        { type: "stage_result", path: "stage_result.json", required: true },
        { type: "text_output", path: reportName, required: true },
      ],
    }, null, 2), "utf8");
    await writeFile(reportPath, "# Protocol Commit Report\n\nobserved without writable path metadata\n", "utf8");
    await writeFile(join(outboxDir, "stage_result.json"), JSON.stringify({
      version: 1,
      stage: workerId,
      status: "completed",
      summary: "worker stage completed via stage_result probe",
      feedback: "stage_result probe should reconcile even for shell-like tools",
      artifacts: [
        { type: "text_output", path: reportName, label: "report", required: true },
      ],
      primaryArtifactPath: reportName,
      completion: {
        status: "completed",
      },
    }, null, 2), "utf8");

    rememberTrackingState(sessionKey, trackingState);
    initTrace(sessionKey, trackingState.contract);

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
      "stage_result probe should finalize the shared contract even when tool metadata lacks a path",
    );
    assert.ok(
      taskHistory.some((entry) => entry.sessionKey === sessionKey && entry.status === CONTRACT_STATUS.COMPLETED),
      "stage_result probe should still emit a terminal track_end history record",
    );
  } finally {
    taskHistory.length = originalTaskHistoryLength;
    clearProtocolCommitReconcileState();
    clearTrackingStore();
    clearAllTraces();
    runtimeAgentConfigs.clear();
    await unlink(contractPath).catch(() => {});
    await unlink(finalOutputPath).catch(() => {});
    await unlink(join(controllerOutputDir, reportName)).catch(() => {});
    await rm(workspaceDir, { recursive: true, force: true });
    await rm(join(OC, "workspaces", plannerId), { recursive: true, force: true });
  }
});

test("canonical outbox commit keeps planner reservation until deferred release is flushed", async () => {
  const plannerId = `planner-proto-tail-${Date.now()}`;
  const workerId = `worker-proto-tail-${Date.now()}`;
  const workspaceDir = join(OC, "workspaces", plannerId);
  const inboxDir = join(workspaceDir, "inbox");
  const outboxDir = join(workspaceDir, "outbox");
  const controllerOutputDir = join(OC, "workspaces", "controller", "output");
  const reportName = `protocol-tail-${Date.now()}.md`;
  const reportPath = join(outboxDir, reportName);
  const contractId = `TC-PROTOCOL-TAIL-${Date.now()}`;
  const contractPath = getContractPath(contractId);
  const finalOutputPath = join(controllerOutputDir, `${contractId}.md`);
  const sessionKey = `agent:${plannerId}:contract:${contractId}`;
  const originalTaskHistoryLength = taskHistory.length;

  registerRuntimeAgents(buildRuntimeConfig({ plannerId, workerId }));
  clearTrackingStore();
  clearAllTraces();

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
    enqueueFn: () => {},
    wakeContractor: async () => null,
  });

  try {
    await persistContractSnapshot(contractPath, sharedContract, logger);
    await writeFile(join(inboxDir, "contract.json"), JSON.stringify(sharedContract, null, 2), "utf8");
    await writeFile(finalOutputPath, "# Planner Protocol Commit\n\nplanner finished logical work before natural agent_end\n", "utf8");

    rememberTrackingState(sessionKey, trackingState);
    initTrace(sessionKey, trackingState.contract);
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

    assert.equal(
      isDispatchTargetBusy(plannerId),
      true,
      "synthetic completion should keep planner reservation busy until deferred release runs",
    );

    await flushProtocolCommitDeferredRelease(sessionKey);

    assert.equal(
      isDispatchTargetBusy(plannerId),
      false,
      "flushing deferred release should finally free the planner reservation",
    );
  } finally {
    taskHistory.length = originalTaskHistoryLength;
    clearProtocolCommitReconcileState();
    clearTrackingStore();
    clearAllTraces();
    runtimeAgentConfigs.clear();
    await unlink(contractPath).catch(() => {});
    await unlink(finalOutputPath).catch(() => {});
    await unlink(join(controllerOutputDir, reportName)).catch(() => {});
    await rm(workspaceDir, { recursive: true, force: true });
    await rm(join(OC, "workspaces", workerId), { recursive: true, force: true });
  }
});
