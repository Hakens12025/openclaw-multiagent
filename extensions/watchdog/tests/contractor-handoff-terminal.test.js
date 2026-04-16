import test from "node:test";
import assert from "node:assert/strict";
import { unlink } from "node:fs/promises";

import {
  createTrackingState,
} from "../lib/session-bootstrap.js";
import {
  listAgentEndMainStages,
} from "../lib/lifecycle/agent-end-pipeline.js";
import {
  getContractPath,
  persistContractSnapshot,
} from "../lib/contracts.js";
import {
  registerRuntimeAgents,
} from "../lib/agent/agent-identity.js";
import {
  CONTRACT_STATUS,
  SYSTEM_ACTION_STATUS,
} from "../lib/core/runtime-status.js";
import { runtimeAgentConfigs } from "../lib/state.js";
import {
  buildDispatchRuntimeSnapshot,
  clearDispatchQueue,
  resetAllDispatchStates,
  syncDispatchTargets,
} from "../lib/routing/dispatch-runtime-state.js";

const logger = {
  info() {},
  warn() {},
  error() {},
};

test("invalid legacy start_pipeline unknown action fails the root contract after handoff collection", async () => {
  const contractId = `TC-CONTRACTOR-HANDOFF-${Date.now()}`;
  const contractPath = getContractPath(contractId);
  const commitStage = listAgentEndMainStages().find((stage) => stage.id === "commit_success_terminal");
  registerRuntimeAgents({
    agents: {
      list: [
        {
          id: "contractor",
          binding: {
            roleRef: "planner",
            workspace: { configured: "~/.openclaw/workspaces/contractor" },
            model: { ref: "demo/contractor" },
          },
        },
      ],
    },
  });

  await persistContractSnapshot(contractPath, {
    id: contractId,
    task: "对比 React、Vue、Svelte 三个框架的优缺点，写一份报告",
    assignee: "worker",
    replyTo: {
      agentId: "controller",
      sessionKey: "agent:controller:main",
    },
    phases: ["搜索相关资料", "分析整理", "撰写报告"],
    total: 3,
    output: `/tmp/${contractId}.md`,
    status: CONTRACT_STATUS.PENDING,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    protocol: {
      version: 1,
      envelope: "execution_contract",
      transport: "contracts/*.json",
      source: "webui",
      route: "long",
    },
    planningContext: {
      route: "long",
      activeLoopCount: 1,
      activeLoopCandidates: [
        {
          loopId: "research-loop",
          entryAgentId: "researcher",
          nodes: ["researcher", "worker-d", "evaluator"],
        },
      ],
    },
  }, logger);

  try {
    const trackingState = createTrackingState({
      sessionKey: `agent:contractor:test:${Date.now()}`,
      agentId: "contractor",
      parentSession: null,
    });
    trackingState.contract = {
      id: contractId,
      task: "对比 React、Vue、Svelte 三个框架的优缺点，写一份报告",
      assignee: "worker",
      phases: ["搜索相关资料", "分析整理", "撰写报告"],
      total: 3,
      output: `/tmp/${contractId}.md`,
      status: CONTRACT_STATUS.PENDING,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      protocol: {
        version: 1,
        envelope: "execution_contract",
      },
      path: contractPath,
    };

    const context = {
      agentId: "contractor",
      sessionKey: trackingState.sessionKey,
      event: { success: true, error: null },
      trackingState,
      effectiveContractData: {
        id: contractId,
        task: "对比 React、Vue、Svelte 三个框架的优缺点，写一份报告",
        status: CONTRACT_STATUS.PENDING,
        phases: ["搜索相关资料", "分析整理", "撰写报告"],
        total: 3,
        output: `/tmp/${contractId}.md`,
      },
      executionObservation: {
        collected: true,
        contractId,
        status: CONTRACT_STATUS.PENDING,
      },
      systemActionResult: {
        status: SYSTEM_ACTION_STATUS.UNKNOWN_ACTION,
        actionType: "start_pipeline",
        error: "unknown action type",
        targetAgent: null,
        contractId: null,
        wake: null,
      },
      contractReadDiagnostic: null,
      lateCompletionLease: null,
      api: {
        runtime: {
          system: {
            requestHeartbeatNow() {},
          },
        },
      },
      logger,
    };

    await commitStage.run(context);

    const persisted = JSON.parse(await import("node:fs/promises").then(({ readFile }) => readFile(contractPath, "utf8")));
    assert.equal(trackingState.status, CONTRACT_STATUS.FAILED);
    assert.equal(trackingState.contract.status, CONTRACT_STATUS.FAILED);
    assert.equal(persisted.status, CONTRACT_STATUS.FAILED);
    assert.equal(persisted.runtimeDiagnostics?.contractorHandoff, undefined);
    assert.equal(persisted.terminalOutcome?.status, CONTRACT_STATUS.FAILED);
  } finally {
    runtimeAgentConfigs.clear();
    await unlink(contractPath).catch(() => {});
  }
});

test("legacy contractor start_pipeline unknown action fails the root contract when no worker handoff was emitted", async () => {
  const contractId = `TC-CONTRACTOR-FALLBACK-${Date.now()}`;
  const contractPath = getContractPath(contractId);
  const commitStage = listAgentEndMainStages().find((stage) => stage.id === "commit_success_terminal");
  clearDispatchQueue();
  resetAllDispatchStates();
  await syncDispatchTargets([], logger);
  registerRuntimeAgents({
    agents: {
      list: [
        {
          id: "contractor",
          binding: {
            roleRef: "planner",
            workspace: { configured: "~/.openclaw/workspaces/contractor" },
            model: { ref: "demo/contractor" },
          },
        },
      ],
    },
  });

  await persistContractSnapshot(contractPath, {
    id: contractId,
    task: "对比 React、Vue、Svelte 三个框架的优缺点，写一份报告",
    assignee: "worker",
    replyTo: {
      agentId: "controller",
      sessionKey: "agent:controller:main",
    },
    phases: ["搜索相关资料", "分析整理", "撰写报告"],
    total: 3,
    output: `/tmp/${contractId}.md`,
    status: CONTRACT_STATUS.PENDING,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    protocol: {
      version: 1,
      envelope: "execution_contract",
      transport: "contracts/*.json",
      source: "webui",
      route: "long",
    },
  }, logger);

  try {
    const trackingState = createTrackingState({
      sessionKey: `agent:contractor:test:${Date.now()}`,
      agentId: "contractor",
      parentSession: null,
    });
    trackingState.contract = {
      id: contractId,
      task: "对比 React、Vue、Svelte 三个框架的优缺点，写一份报告",
      assignee: "worker",
      phases: ["搜索相关资料", "分析整理", "撰写报告"],
      total: 3,
      output: `/tmp/${contractId}.md`,
      status: CONTRACT_STATUS.PENDING,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      protocol: {
        version: 1,
        envelope: "execution_contract",
      },
      path: contractPath,
    };

    const context = {
      agentId: "contractor",
      sessionKey: trackingState.sessionKey,
      event: { success: true, error: null },
      trackingState,
      effectiveContractData: {
        id: contractId,
        task: "对比 React、Vue、Svelte 三个框架的优缺点，写一份报告",
        assignee: "worker",
        status: CONTRACT_STATUS.PENDING,
        phases: ["搜索相关资料", "分析整理", "撰写报告"],
        total: 3,
        output: `/tmp/${contractId}.md`,
        protocol: {
          version: 1,
          envelope: "execution_contract",
          source: "webui",
          route: "long",
        },
      },
      executionObservation: {
        collected: false,
      },
      systemActionResult: {
        status: SYSTEM_ACTION_STATUS.UNKNOWN_ACTION,
        actionType: "start_pipeline",
        error: "unknown action type",
        targetAgent: null,
        contractId: null,
        wake: null,
      },
      contractReadDiagnostic: null,
      lateCompletionLease: null,
      api: {
        runtime: {
          system: {
            requestHeartbeatNow() {},
          },
        },
      },
      logger,
    };

    await commitStage.run(context);

    const persisted = JSON.parse(await import("node:fs/promises").then(({ readFile }) => readFile(contractPath, "utf8")));
    assert.equal(persisted.status, CONTRACT_STATUS.FAILED);
    assert.equal(buildDispatchRuntimeSnapshot().queue.includes(contractId), false);
    assert.equal(persisted.runtimeDiagnostics?.contractorFallback, undefined);
    assert.equal(persisted.terminalOutcome?.status, CONTRACT_STATUS.FAILED);
  } finally {
    runtimeAgentConfigs.clear();
    await unlink(contractPath).catch(() => {});
    clearDispatchQueue();
    resetAllDispatchStates();
    await syncDispatchTargets([], logger);
  }
});

test("running tracking state does not preserve the root contract when terminal evaluation fails", async () => {
  const contractId = `TC-CONTRACTOR-RUNNING-${Date.now()}`;
  const contractPath = getContractPath(contractId);
  const commitStage = listAgentEndMainStages().find((stage) => stage.id === "commit_success_terminal");
  registerRuntimeAgents({
    agents: {
      list: [
        {
          id: "contractor",
          binding: {
            roleRef: "planner",
            workspace: { configured: "~/.openclaw/workspaces/contractor" },
            model: { ref: "demo/contractor" },
          },
        },
      ],
    },
  });

  await persistContractSnapshot(contractPath, {
    id: contractId,
    task: "长任务已被 worker 接单，contractor 只负责交接",
    assignee: "worker-c",
    replyTo: {
      agentId: "controller",
      sessionKey: "agent:controller:main",
    },
    phases: ["搜索相关资料", "分析整理", "撰写报告"],
    total: 3,
    output: `/tmp/${contractId}.md`,
    status: CONTRACT_STATUS.RUNNING,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    protocol: {
      version: 1,
      envelope: "execution_contract",
      transport: "contracts/*.json",
      source: "webui",
      route: "long",
    },
  }, logger);

  try {
    const trackingState = createTrackingState({
      sessionKey: `agent:contractor:test:${Date.now()}`,
      agentId: "contractor",
      parentSession: null,
    });
    trackingState.status = CONTRACT_STATUS.RUNNING;
    trackingState.contract = {
      id: contractId,
      task: "长任务已被 worker 接单，contractor 只负责交接",
      assignee: "worker-c",
      phases: ["搜索相关资料", "分析整理", "撰写报告"],
      total: 3,
      output: `/tmp/${contractId}.md`,
      status: CONTRACT_STATUS.RUNNING,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      protocol: {
        version: 1,
        envelope: "execution_contract",
      },
      path: contractPath,
    };

    const context = {
      agentId: "contractor",
      sessionKey: trackingState.sessionKey,
      event: { success: true, error: null },
      trackingState,
      effectiveContractData: {
        id: contractId,
        task: "长任务已被 worker 接单，contractor 只负责交接",
        assignee: "worker-c",
        status: CONTRACT_STATUS.RUNNING,
        phases: ["搜索相关资料", "分析整理", "撰写报告"],
        total: 3,
        output: `/tmp/${contractId}.md`,
      },
      executionObservation: {
        collected: true,
        contractId,
        status: CONTRACT_STATUS.PENDING,
      },
      systemActionResult: {
        status: SYSTEM_ACTION_STATUS.NO_ACTION,
        actionType: null,
        error: null,
        targetAgent: null,
        contractId: null,
        wake: null,
      },
      contractReadDiagnostic: null,
      lateCompletionLease: null,
      api: {
        runtime: {
          system: {
            requestHeartbeatNow() {},
          },
        },
      },
      logger,
    };

    await commitStage.run(context);

    const persisted = JSON.parse(await import("node:fs/promises").then(({ readFile }) => readFile(contractPath, "utf8")));
    assert.equal(trackingState.status, CONTRACT_STATUS.FAILED);
    assert.equal(trackingState.contract.status, CONTRACT_STATUS.FAILED);
    assert.equal(persisted.status, CONTRACT_STATUS.FAILED);
    assert.equal(persisted.runtimeDiagnostics?.contractorHandoff, undefined);
    assert.equal(persisted.terminalOutcome?.status, CONTRACT_STATUS.FAILED);
  } finally {
    runtimeAgentConfigs.clear();
    await unlink(contractPath).catch(() => {});
  }
});
