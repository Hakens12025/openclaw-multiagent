import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 投递出栈(备忘录141 §八):commit_success_terminal 不再就地跑两段投递,
// 而是落自包含票据 + poke 真泵——票据目录环境种子改道临时目录,绝不写真 control-plane。
process.env.OPENCLAW_DELIVERY_TICKET_DIR = mkdtempSync(join(tmpdir(), "contractor-handoff-tickets-"));

import {
  createTrackingState,
} from "../lib/session/session-bootstrap.js";
import {
  listAgentEndMainStages,
} from "../lib/lifecycle/agent-end/lifecycle.js";
import {
  getContractPath,
  persistContractById,
} from "../lib/contract/contracts.js";
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
} from "../lib/routing/dispatch/dispatch-runtime-state.js";

const logger = {
  info() {},
  warn() {},
  error() {},
};

test("invalid legacy start_pipeline unknown action fails the root contract after handoff collection", async () => {
  const contractId = `TC-CONTRACTOR-HANDOFF-${Date.now()}`;
  let contractPath = getContractPath(contractId);
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

  contractPath = await persistContractById({
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
    },
    planningContext: {
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
    // 投递出栈:两段投递不再在 stage 内发生,收口只落票据;断言读 tracker 内存正本
    // (盘上副本会被真泵后台并回诊断,读盘断言有竞态)。
    assert.equal(
      trackingState.contract.runtimeDiagnostics?.deliveryTicketId,
      `dlv-${contractId}`,
      "收口必须写投递票据并在 runtimeDiagnostics 记 deliveryTicketId",
    );
  } finally {
    runtimeAgentConfigs.clear();
    await unlink(contractPath).catch(() => {});
  }
});

test("legacy contractor start_pipeline unknown action fails the root contract when no worker handoff was emitted", async () => {
  const contractId = `TC-CONTRACTOR-FALLBACK-${Date.now()}`;
  let contractPath = getContractPath(contractId);
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

  contractPath = await persistContractById({
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
    // 投递出栈:两段投递不再在 stage 内发生,收口只落票据;断言读 tracker 内存正本
    // (盘上副本会被真泵后台并回诊断,读盘断言有竞态)。
    assert.equal(
      trackingState.contract.runtimeDiagnostics?.deliveryTicketId,
      `dlv-${contractId}`,
      "收口必须写投递票据并在 runtimeDiagnostics 记 deliveryTicketId",
    );
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
  let contractPath = getContractPath(contractId);
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

  contractPath = await persistContractById({
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
    // 投递出栈:两段投递不再在 stage 内发生,收口只落票据;断言读 tracker 内存正本
    // (盘上副本会被真泵后台并回诊断,读盘断言有竞态)。
    assert.equal(
      trackingState.contract.runtimeDiagnostics?.deliveryTicketId,
      `dlv-${contractId}`,
      "收口必须写投递票据并在 runtimeDiagnostics 记 deliveryTicketId",
    );
  } finally {
    runtimeAgentConfigs.clear();
    await unlink(contractPath).catch(() => {});
  }
});

test("agent final assistant text is not captured as contract output", async () => {
  const contractId = `TC-TERMINAL-CAPTURE-${Date.now()}`;
  let contractPath = getContractPath(contractId);
  const outputPath = `/tmp/${contractId}.md`;
  const commitStage = listAgentEndMainStages().find((stage) => stage.id === "commit_success_terminal");
  registerRuntimeAgents({
    agents: {
      list: [
        {
          id: "worker2",
          binding: {
            roleRef: "executor",
            workspace: { configured: "~/.openclaw/workspaces/worker2" },
            model: { ref: "demo/worker2" },
          },
        },
      ],
    },
  });

  contractPath = await persistContractById({
    id: contractId,
    task: "用户原话：你好",
    assignee: "worker2",
    output: outputPath,
    status: CONTRACT_STATUS.PENDING,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    protocol: {
      version: 1,
      envelope: "execution_contract",
      source: "webui",
    },
  }, logger);

  try {
    const trackingState = createTrackingState({
      sessionKey: `agent:worker2:contract:${contractId.toLowerCase()}`,
      agentId: "worker2",
      parentSession: null,
    });
    trackingState.contract = {
      id: contractId,
      task: "用户原话：你好",
      assignee: "worker2",
      output: outputPath,
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
      agentId: "worker2",
      sessionKey: trackingState.sessionKey,
      event: {
        success: true,
        error: null,
        messages: [
          {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "先想一下怎么回复。" },
              { type: "text", text: "你好！我在这里，有什么我可以帮你的吗？" },
            ],
          },
        ],
      },
      trackingState,
      effectiveContractData: {
        id: contractId,
        task: "用户原话：你好",
        assignee: "worker2",
        status: CONTRACT_STATUS.PENDING,
        output: outputPath,
      },
      executionObservation: {
        collected: false,
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

    const { readFile } = await import("node:fs/promises");
    const persisted = JSON.parse(await readFile(contractPath, "utf8"));

    await assert.rejects(readFile(outputPath, "utf8"));
    assert.equal(trackingState.status, CONTRACT_STATUS.FAILED);
    assert.equal(trackingState.contract.status, CONTRACT_STATUS.FAILED);
    assert.equal(persisted.status, CONTRACT_STATUS.FAILED);
    assert.equal(persisted.terminalOutcome?.status, CONTRACT_STATUS.FAILED);
    assert.equal(persisted.terminalOutcome?.source, "deliverable");
    assert.equal(persisted.terminalOutcome?.reason, "contract.output missing_file");
    assert.equal(persisted.runtimeDiagnostics?.completionCapture, undefined);
    // 投递出栈:两段投递不再在 stage 内发生,收口只落票据;断言读 tracker 内存正本
    // (盘上副本会被真泵后台并回诊断,读盘断言有竞态)。
    assert.equal(
      trackingState.contract.runtimeDiagnostics?.deliveryTicketId,
      `dlv-${contractId}`,
      "收口必须写投递票据并在 runtimeDiagnostics 记 deliveryTicketId",
    );
  } finally {
    runtimeAgentConfigs.clear();
    await unlink(contractPath).catch(() => {});
    await unlink(outputPath).catch(() => {});
  }
});

test("control-only assistant text is not captured as contract output", async () => {
  const contractId = `TC-TERMINAL-CAPTURE-CONTROL-${Date.now()}`;
  let contractPath = getContractPath(contractId);
  const outputPath = `/tmp/${contractId}.md`;
  const commitStage = listAgentEndMainStages().find((stage) => stage.id === "commit_success_terminal");
  registerRuntimeAgents({
    agents: {
      list: [
        {
          id: "worker2",
          binding: {
            roleRef: "executor",
            workspace: { configured: "~/.openclaw/workspaces/worker2" },
            model: { ref: "demo/worker2" },
          },
        },
      ],
    },
  });

  contractPath = await persistContractById({
    id: contractId,
    task: "控制文本不应被当作最终交付",
    assignee: "worker2",
    output: outputPath,
    status: CONTRACT_STATUS.PENDING,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    protocol: {
      version: 1,
      envelope: "execution_contract",
      source: "webui",
    },
  }, logger);

  try {
    const trackingState = createTrackingState({
      sessionKey: `agent:worker2:contract:${contractId.toLowerCase()}`,
      agentId: "worker2",
      parentSession: null,
    });
    trackingState.contract = {
      id: contractId,
      task: "控制文本不应被当作最终交付",
      assignee: "worker2",
      output: outputPath,
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
      agentId: "worker2",
      sessionKey: trackingState.sessionKey,
      event: {
        success: true,
        error: null,
        messages: [
          {
            role: "assistant",
            content: [
              { type: "text", text: "NO_REPLY" },
            ],
          },
        ],
      },
      trackingState,
      effectiveContractData: {
        id: contractId,
        task: "控制文本不应被当作最终交付",
        assignee: "worker2",
        status: CONTRACT_STATUS.PENDING,
        output: outputPath,
      },
      executionObservation: {
        collected: false,
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

    const { readFile } = await import("node:fs/promises");
    const persisted = JSON.parse(await readFile(contractPath, "utf8"));

    await assert.rejects(readFile(outputPath, "utf8"));
    assert.equal(trackingState.status, CONTRACT_STATUS.FAILED);
    assert.equal(trackingState.contract.status, CONTRACT_STATUS.FAILED);
    assert.equal(persisted.status, CONTRACT_STATUS.FAILED);
    assert.equal(persisted.terminalOutcome?.status, CONTRACT_STATUS.FAILED);
    assert.equal(persisted.terminalOutcome?.source, "deliverable");
    assert.equal(persisted.terminalOutcome?.reason, "contract.output missing_file");
    assert.equal(persisted.runtimeDiagnostics?.completionCapture, undefined);
    // 投递出栈:两段投递不再在 stage 内发生,收口只落票据;断言读 tracker 内存正本
    // (盘上副本会被真泵后台并回诊断,读盘断言有竞态)。
    assert.equal(
      trackingState.contract.runtimeDiagnostics?.deliveryTicketId,
      `dlv-${contractId}`,
      "收口必须写投递票据并在 runtimeDiagnostics 记 deliveryTicketId",
    );
  } finally {
    runtimeAgentConfigs.clear();
    await unlink(contractPath).catch(() => {});
    await unlink(outputPath).catch(() => {});
  }
});

test("runtime guard text is not captured as contract output", async () => {
  const contractId = `TC-TERMINAL-CAPTURE-GUARD-${Date.now()}`;
  let contractPath = getContractPath(contractId);
  const outputPath = `/tmp/${contractId}.md`;
  const commitStage = listAgentEndMainStages().find((stage) => stage.id === "commit_success_terminal");
  registerRuntimeAgents({
    agents: {
      list: [
        {
          id: "worker2",
          binding: {
            roleRef: "executor",
            workspace: { configured: "~/.openclaw/workspaces/worker2" },
            model: { ref: "demo/worker2" },
          },
        },
      ],
    },
  });

  contractPath = await persistContractById({
    id: contractId,
    task: "runtime 提示文本不应被当作最终交付",
    assignee: "worker2",
    output: outputPath,
    status: CONTRACT_STATUS.PENDING,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    protocol: {
      version: 1,
      envelope: "execution_contract",
      source: "webui",
    },
  }, logger);

  try {
    const trackingState = createTrackingState({
      sessionKey: `agent:worker2:contract:${contractId.toLowerCase()}`,
      agentId: "worker2",
      parentSession: null,
    });
    trackingState.contract = {
      id: contractId,
      task: "runtime 提示文本不应被当作最终交付",
      assignee: "worker2",
      output: outputPath,
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
      agentId: "worker2",
      sessionKey: trackingState.sessionKey,
      event: {
        success: true,
        error: null,
        messages: [
          {
            role: "assistant",
            content: [
              { type: "text", text: "根据系统提示，请直接写入结果路径。" },
            ],
          },
        ],
      },
      trackingState,
      effectiveContractData: {
        id: contractId,
        task: "runtime 提示文本不应被当作最终交付",
        assignee: "worker2",
        status: CONTRACT_STATUS.PENDING,
        output: outputPath,
      },
      executionObservation: {
        collected: false,
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

    const { readFile } = await import("node:fs/promises");
    const persisted = JSON.parse(await readFile(contractPath, "utf8"));

    await assert.rejects(readFile(outputPath, "utf8"));
    assert.equal(trackingState.status, CONTRACT_STATUS.FAILED);
    assert.equal(trackingState.contract.status, CONTRACT_STATUS.FAILED);
    assert.equal(persisted.status, CONTRACT_STATUS.FAILED);
    assert.equal(persisted.terminalOutcome?.status, CONTRACT_STATUS.FAILED);
    assert.equal(persisted.terminalOutcome?.source, "deliverable");
    assert.equal(persisted.terminalOutcome?.reason, "contract.output missing_file");
    assert.equal(persisted.runtimeDiagnostics?.completionCapture, undefined);
    // 投递出栈:两段投递不再在 stage 内发生,收口只落票据;断言读 tracker 内存正本
    // (盘上副本会被真泵后台并回诊断,读盘断言有竞态)。
    assert.equal(
      trackingState.contract.runtimeDiagnostics?.deliveryTicketId,
      `dlv-${contractId}`,
      "收口必须写投递票据并在 runtimeDiagnostics 记 deliveryTicketId",
    );
  } finally {
    runtimeAgentConfigs.clear();
    await unlink(contractPath).catch(() => {});
    await unlink(outputPath).catch(() => {});
  }
});

test("invalid tool-error payload already written into contract.output fails terminal evaluation", async () => {
  const contractId = `TC-TERMINAL-INVALID-OUTPUT-${Date.now()}`;
  let contractPath = getContractPath(contractId);
  const outputPath = `/tmp/${contractId}.md`;
  const commitStage = listAgentEndMainStages().find((stage) => stage.id === "commit_success_terminal");
  registerRuntimeAgents({
    agents: {
      list: [
        {
          id: "worker2",
          binding: {
            roleRef: "executor",
            workspace: { configured: "~/.openclaw/workspaces/worker2" },
            model: { ref: "demo/worker2" },
          },
        },
      ],
    },
  });

  contractPath = await persistContractById({
    id: contractId,
    task: "工具错误残渣不应被当作完成产物",
    assignee: "worker2",
    output: outputPath,
    status: CONTRACT_STATUS.PENDING,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    protocol: {
      version: 1,
      envelope: "execution_contract",
      source: "webui",
    },
  }, logger);

  await writeFile(outputPath, JSON.stringify({
    status: "error",
    tool: "write",
    file_path: "/Users/hakens/.openclaw/workspaces/worker2/outbox/runtime_result.json",
  }, null, 2), "utf8");

  try {
    const trackingState = createTrackingState({
      sessionKey: `agent:worker2:contract:${contractId.toLowerCase()}`,
      agentId: "worker2",
      parentSession: null,
    });
    trackingState.contract = {
      id: contractId,
      task: "工具错误残渣不应被当作完成产物",
      assignee: "worker2",
      output: outputPath,
      status: CONTRACT_STATUS.PENDING,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      runtimeDiagnostics: {
        executionTrace: {
          outputCommitted: true,
        },
      },
      protocol: {
        version: 1,
        envelope: "execution_contract",
      },
      path: contractPath,
    };

    const context = {
      agentId: "worker2",
      sessionKey: trackingState.sessionKey,
      event: {
        success: true,
        error: null,
        messages: [],
      },
      trackingState,
      effectiveContractData: {
        id: contractId,
        task: "工具错误残渣不应被当作完成产物",
        assignee: "worker2",
        status: CONTRACT_STATUS.PENDING,
        output: outputPath,
        runtimeDiagnostics: {
          executionTrace: {
            outputCommitted: true,
          },
        },
      },
      executionObservation: {
        collected: true,
        primaryOutputPath: outputPath,
        artifactPaths: [outputPath],
        files: [outputPath],
        stageRunResult: {
          status: "completed",
          summary: "runtime_result declared an invalid artifact",
          artifacts: [
            {
              type: "text_output",
              path: outputPath,
              label: "invalid_output",
              primary: true,
              required: true,
            },
          ],
          primaryArtifactPath: outputPath,
        },
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

    const { readFile } = await import("node:fs/promises");
    const persisted = JSON.parse(await readFile(contractPath, "utf8"));

    assert.equal(trackingState.status, CONTRACT_STATUS.FAILED);
    assert.equal(trackingState.contract.status, CONTRACT_STATUS.FAILED);
    assert.equal(persisted.status, CONTRACT_STATUS.FAILED);
    assert.equal(persisted.terminalOutcome?.status, CONTRACT_STATUS.FAILED);
    assert.match(persisted.terminalOutcome?.reason || "", /invalid_semantic_payload/u);
    // 投递出栈:两段投递不再在 stage 内发生,收口只落票据;断言读 tracker 内存正本
    // (盘上副本会被真泵后台并回诊断,读盘断言有竞态)。
    assert.equal(
      trackingState.contract.runtimeDiagnostics?.deliveryTicketId,
      `dlv-${contractId}`,
      "收口必须写投递票据并在 runtimeDiagnostics 记 deliveryTicketId",
    );
  } finally {
    runtimeAgentConfigs.clear();
    await unlink(contractPath).catch(() => {});
    await unlink(outputPath).catch(() => {});
  }
});
