import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, readdir, rm, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { registerRuntimeAgents } from "../lib/agent/agent-identity.js";
import { OC, agentWorkspace, dispatchTargetStateMap, runtimeAgentConfigs, sseClients } from "../lib/state.js";
import { getContractPath, persistContractSnapshot } from "../lib/contracts.js";
import { evictContractSnapshotByPath } from "../lib/store/contract-store.js";
import {
  createTrackingState,
  bindInboxContractEnvelope,
} from "../lib/session-bootstrap.js";
import { commitSemanticTerminalState } from "../lib/terminal-commit.js";
import {
  deriveSystemActionTerminalOutcome,
} from "../lib/system-action/system-action-runtime-ledger.js";
import { SYSTEM_ACTION_STATUS, CONTRACT_STATUS } from "../lib/core/runtime-status.js";
import { INTENT_TYPES, normalizeSystemIntent } from "../lib/protocol-primitives.js";
import { getSemanticSkillSpec } from "../lib/semantic-skill-registry.js";
import { materializeTaskStagePlan } from "../lib/task-stage-plan.js";
import { deriveDelegationIntentForEarlyCheck } from "../hooks/after-tool-call.js";
import { runContractorInboxTestSerial } from "./test-locks.js";

const logger = {
  info() {},
  warn() {},
  error() {},
};

async function primeRuntimeAgents() {
  const config = JSON.parse(await readFile(join(OC, "openclaw.json"), "utf8"));
  registerRuntimeAgents(config);
}

async function snapshotFile(filePath) {
  try {
    return await readFile(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function restoreFile(filePath, snapshot) {
  if (snapshot === null) {
    await unlink(filePath).catch(() => {});
    return;
  }
  await writeFile(filePath, snapshot);
}

async function findRuntimeDirectInboxContract(inboxDir, predicate) {
  const activePath = join(inboxDir, "contract.json");
  try {
    const contract = JSON.parse(await readFile(activePath, "utf8"));
    if (predicate(contract, { source: "active", path: activePath })) {
      return {
        source: "active",
        path: activePath,
        contract,
      };
    }
  } catch {}

  const queueDir = join(inboxDir, ".runtime-direct-queue");
  try {
    const names = (await readdir(queueDir))
      .filter((name) => /^contract-.*\.json$/i.test(name))
      .sort();
    for (const name of names) {
      const path = join(queueDir, name);
      try {
        const contract = JSON.parse(await readFile(path, "utf8"));
        if (predicate(contract, { source: "queue", path })) {
          return {
            source: "queue",
            path,
            contract,
          };
        }
      } catch {}
    }
  } catch {}

  return null;
}

function captureSseEvents() {
  const events = [];
  const client = {
    finished: false,
    destroyed: false,
    write(payload) {
      const eventMatch = String(payload).match(/^event:\s*(.+)$/m);
      const dataMatch = String(payload).match(/^data:\s*(.+)$/m);
      if (!eventMatch || !dataMatch) return;
      events.push({
        event: eventMatch[1],
        data: JSON.parse(dataMatch[1]),
      });
    },
  };
  sseClients.add(client);
  return {
    events,
    close() {
      sseClients.delete(client);
    },
  };
}

test("contractor inbox pending execution contract binds into tracking state", async () => runContractorInboxTestSerial(async () => {
  const inboxDir = join(agentWorkspace("contractor"), "inbox");
  const contractPath = join(inboxDir, "contract.json");
  const original = await snapshotFile(contractPath);

  await mkdir(inboxDir, { recursive: true });

  try {
    const contract = {
      id: `TC-P0-CONTRACTOR-${Date.now()}`,
      task: "planner pending inbox binding regression",
      assignee: "contractor",
      status: CONTRACT_STATUS.PENDING,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      phases: [],
      total: 1,
      output: join(agentWorkspace("controller"), "output", `TC-P0-CONTRACTOR-${Date.now()}.md`),
      protocol: {
        version: 1,
        envelope: "execution_contract",
      },
    };
    await writeFile(contractPath, JSON.stringify(contract, null, 2), "utf8");

    const trackingState = createTrackingState({
      sessionKey: `agent:contractor:test:${Date.now()}`,
      agentId: "contractor",
      parentSession: null,
    });

    const bound = await bindInboxContractEnvelope({
      agentId: "contractor",
      trackingState,
      logger,
      allowNonDirectRequest: true,
    });

    assert.equal(bound?.contract?.id, contract.id);
    assert.equal(trackingState.contract?.id, contract.id);
    assert.equal(trackingState.contract?.status, CONTRACT_STATUS.PENDING);
  } finally {
    await restoreFile(contractPath, original);
  }
}));

test("planner shared execution contract bind promotes canonical contract status to running", async () => runContractorInboxTestSerial(async () => {
  await primeRuntimeAgents();

  const inboxDir = join(agentWorkspace("planner"), "inbox");
  const inboxContractPath = join(inboxDir, "contract.json");
  const inboxOriginal = await snapshotFile(inboxContractPath);
  const contractId = `TC-P0-PLANNER-SHARED-${Date.now()}`;
  const sharedContractPath = getContractPath(contractId);
  const sharedOriginal = await snapshotFile(sharedContractPath);

  await mkdir(inboxDir, { recursive: true });

  try {
    const contract = {
      id: contractId,
      task: "planner shared contract should turn running when bound",
      assignee: "planner",
      status: CONTRACT_STATUS.PENDING,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      phases: ["执行"],
      total: 1,
      output: join(agentWorkspace("controller"), "output", `${contractId}.md`),
      protocol: {
        version: 1,
        envelope: "execution_contract",
      },
    };

    await persistContractSnapshot(sharedContractPath, contract, logger);
    await writeFile(inboxContractPath, JSON.stringify(contract, null, 2), "utf8");

    const trackingState = createTrackingState({
      sessionKey: `agent:planner:contract:${contractId}`,
      agentId: "planner",
      parentSession: null,
    });

    const bound = await bindInboxContractEnvelope({
      agentId: "planner",
      trackingState,
      logger,
      allowNonDirectRequest: true,
      requiredContractId: contractId,
    });

    const persisted = JSON.parse(await readFile(sharedContractPath, "utf8"));

    assert.equal(bound?.contract?.id, contractId);
    assert.equal(trackingState.contract?.id, contractId);
    assert.equal(trackingState.contract?.status, CONTRACT_STATUS.RUNNING);
    assert.equal(persisted.status, CONTRACT_STATUS.RUNNING);
  } finally {
    evictContractSnapshotByPath(sharedContractPath);
    await restoreFile(inboxContractPath, inboxOriginal);
    await restoreFile(sharedContractPath, sharedOriginal);
  }
}));

test("bindInboxContractEnvelope rejects legacy planner draft contracts", async () => runContractorInboxTestSerial(async () => {
  const inboxDir = join(agentWorkspace("contractor"), "inbox");
  const contractPath = join(inboxDir, "contract.json");
  const original = await snapshotFile(contractPath);

  await mkdir(inboxDir, { recursive: true });

  try {
    const contract = {
      id: `TC-P0-LEGACY-DRAFT-${Date.now()}`,
      task: "legacy planner draft inbox should not bind",
      assignee: "contractor",
      status: CONTRACT_STATUS.DRAFT,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      phases: [],
      total: 1,
      output: join(agentWorkspace("controller"), "output", `TC-P0-LEGACY-DRAFT-${Date.now()}.md`),
      protocol: {
        version: 1,
        envelope: "planner_contract",
      },
    };
    await writeFile(contractPath, JSON.stringify(contract, null, 2), "utf8");

    const trackingState = createTrackingState({
      sessionKey: `agent:contractor:test:${Date.now()}`,
      agentId: "contractor",
      parentSession: null,
    });

    const bound = await bindInboxContractEnvelope({
      agentId: "contractor",
      trackingState,
      logger,
      allowNonDirectRequest: true,
    });

    assert.equal(bound, null);
    assert.equal(trackingState.contract, null);
  } finally {
    await restoreFile(contractPath, original);
  }
}));

test("bindInboxContractEnvelope does not bind a different active inbox contract when exact contract id is required", async () => runContractorInboxTestSerial(async () => {
  const inboxDir = join(agentWorkspace("contractor"), "inbox");
  const contractPath = join(inboxDir, "contract.json");
  const original = await snapshotFile(contractPath);

  await mkdir(inboxDir, { recursive: true });

  try {
    const oldContract = {
      id: `TC-P0-OLD-${Date.now()}`,
      task: "old active contract should not be rebound into exact session",
      assignee: "contractor",
      status: CONTRACT_STATUS.PENDING,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      phases: [],
      total: 1,
      output: join(agentWorkspace("controller"), "output", `TC-P0-OLD-${Date.now()}.md`),
      protocol: {
        version: 1,
        envelope: "execution_contract",
      },
    };
    await writeFile(contractPath, JSON.stringify(oldContract, null, 2), "utf8");

    const trackingState = createTrackingState({
      sessionKey: `agent:contractor:contract:TC-P0-NEW-${Date.now()}`,
      agentId: "contractor",
      parentSession: null,
    });

    const bound = await bindInboxContractEnvelope({
      agentId: "contractor",
      trackingState,
      logger,
      allowNonDirectRequest: true,
      requiredContractId: "TC-P0-NEW",
    });

    assert.equal(bound, null);
    assert.equal(trackingState.contract, null);
  } finally {
    await restoreFile(contractPath, original);
  }
}));

test("findRuntimeDirectInboxContract can locate queued stage contract when active inbox is occupied", async () => {
  const inboxDir = join(tmpdir(), `openclaw-p0-runtime-inbox-${Date.now()}`);
  const queueDir = join(inboxDir, ".runtime-direct-queue");

  await mkdir(queueDir, { recursive: true });

  try {
    await writeFile(join(inboxDir, "contract.json"), JSON.stringify({
      id: "DIRECT-ACTIVE",
      taskType: "direct_request",
      task: "occupied active inbox",
      assignee: "researcher",
      pipelineStage: {
        loopId: "research-loop",
        stage: "researcher",
      },
    }, null, 2), "utf8");

    await writeFile(join(queueDir, "contract-000001-DIRECT-QUEUED.json"), JSON.stringify({
      id: "DIRECT-QUEUED",
      taskType: "direct_request",
      task: "queued target contract",
      assignee: "researcher",
      pipelineStage: {
        loopId: "t2-loop-platform",
        stage: "researcher",
      },
    }, null, 2), "utf8");

    const found = await findRuntimeDirectInboxContract(
      inboxDir,
      (contract) => contract?.pipelineStage?.loopId === "t2-loop-platform",
    );

    assert.equal(found?.source, "queue");
    assert.equal(found?.contract?.id, "DIRECT-QUEUED");
  } finally {
    await rm(inboxDir, { recursive: true, force: true });
  }
});


test("start_loop dispatched is treated as accepted runtime action", () => {
  const systemActionResult = {
    status: SYSTEM_ACTION_STATUS.DISPATCHED,
    actionType: INTENT_TYPES.START_LOOP,
    loopId: "loop-test",
  };

  const terminalOutcome = deriveSystemActionTerminalOutcome(systemActionResult, {
    collected: false,
  });

  assert.equal(terminalOutcome, null);
});

test("commitSemanticTerminalState persists canonical completed stageRuntime for completed stagePlan contracts", async () => {
  const contractId = `TC-P0-STAGE-RUNTIME-${Date.now()}`;
  const contractPath = getContractPath(contractId);

  try {
    const contract = {
      id: contractId,
      path: contractPath,
      task: "completed stage runtime persistence",
      assignee: "worker",
      status: CONTRACT_STATUS.RUNNING,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      phases: ["框架调研与资料收集", "多维度对比分析", "报告整合与输出"],
      total: 3,
      stagePlan: materializeTaskStagePlan({
        contractId,
        phases: ["框架调研与资料收集", "多维度对比分析", "报告整合与输出"],
      }),
      stageRuntime: {
        version: 1,
        currentStageId: "stage-1",
        completedStageIds: [],
        revisionCount: 0,
        lastRevisionReason: null,
      },
      output: join(agentWorkspace("controller"), "output", `${contractId}.md`),
    };
    await persistContractSnapshot(contractPath, contract, logger);

    const trackingState = createTrackingState({
      sessionKey: `agent:worker:test:${Date.now()}`,
      agentId: "worker",
      parentSession: null,
    });
    trackingState.contract = {
      ...contract,
      path: contractPath,
    };

    const commitResult = await commitSemanticTerminalState({
      trackingState,
      terminalStatus: CONTRACT_STATUS.COMPLETED,
      terminalOutcome: {
        status: CONTRACT_STATUS.COMPLETED,
        source: "completion_criteria",
        reason: "artifacts verified",
      },
      logger,
      extraFields: {
        executionObservation: {
          collected: true,
          contractId,
          stageCompletion: {
            status: "completed",
          },
        },
      },
    });

    assert.equal(commitResult.committed, true);

    const persisted = JSON.parse(await readFile(contractPath, "utf8"));
    assert.deepEqual(persisted.stageRuntime, {
      version: 1,
      currentStageId: null,
      completedStageIds: ["stage-1", "stage-2", "stage-3"],
      revisionCount: 0,
      lastRevisionReason: null,
    });
  } finally {
    await unlink(contractPath).catch(() => {});
    evictContractSnapshotByPath(contractPath);
  }
});

test("commitSemanticTerminalState releases dispatch runtime ownership for terminal contracts", async () => {
  const contractId = `TC-P0-TERMINAL-DISPATCH-${Date.now()}`;
  const contractPath = getContractPath(contractId);

  try {
    const contract = {
      id: contractId,
      path: contractPath,
      task: "terminal dispatch owner release",
      assignee: "worker",
      status: CONTRACT_STATUS.RUNNING,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      phases: ["执行"],
      total: 1,
      output: join(agentWorkspace("worker"), "output", `${contractId}.md`),
    };
    await persistContractSnapshot(contractPath, contract, logger);

    dispatchTargetStateMap.clear();
    dispatchTargetStateMap.set("worker", {
      busy: true,
      healthy: true,
      dispatching: false,
      lastSeen: Date.now(),
      currentContract: contractId,
      queue: [],
      roundRobinCursor: 0,
    });

    const trackingState = createTrackingState({
      sessionKey: `agent:worker:test:${Date.now()}`,
      agentId: "worker",
      parentSession: null,
    });
    trackingState.contract = {
      ...contract,
      path: contractPath,
    };

    const commitResult = await commitSemanticTerminalState({
      trackingState,
      terminalStatus: CONTRACT_STATUS.COMPLETED,
      terminalOutcome: {
        status: CONTRACT_STATUS.COMPLETED,
        source: "completion_criteria",
        reason: "artifacts verified",
      },
      logger,
      extraFields: {
        executionObservation: {
          collected: true,
          contractId,
        },
      },
    });

    assert.equal(commitResult.committed, true);
    assert.equal(dispatchTargetStateMap.get("worker")?.busy, false);
    assert.equal(dispatchTargetStateMap.get("worker")?.dispatching, false);
    assert.equal(dispatchTargetStateMap.get("worker")?.currentContract, null);
  } finally {
    dispatchTargetStateMap.clear();
    await unlink(contractPath).catch(() => {});
    evictContractSnapshotByPath(contractPath);
  }
});

test("legacy contractor start_pipeline payload remains raw and no longer normalizes into runtime params", () => {
  const normalized = normalizeSystemIntent({
    action: "start_pipeline",
    pipeline: "t2-loop-platform",
    context: {
      task: "帮我做一下某个卡夫曼算法的优化",
    },
    target: {
      agentId: "researcher",
      sessionKey: "agent:researcher:main",
    },
    contractId: "TC-LEGACY-START-1",
  });

  assert.equal(normalized.type, "start_pipeline");
  assert.equal(normalized.params?.startAgent, undefined);
  assert.equal(normalized.params?.requestedTask, undefined);
  assert.equal(normalized.params?.loopId, undefined);
  assert.equal(normalized.params?.pipelineId, undefined);
});

test("system_action defaults and skill metadata align to marker-based runtime semantics", () => {
  const normalized = normalizeSystemIntent({
    action: "wake_agent",
    params: {
      targetAgent: "worker",
      context: {
        legacy: true,
      },
    },
  });
  const platformTools = getSemanticSkillSpec("platform-tools");

  assert.equal(normalized.protocol.transport, "system_action");
  assert.equal(normalized.params?.context, undefined);
  assert.equal(platformTools?.toolRefs?.includes("outbox/system_action.json"), false);
});

test("after-tool-call early delegation check ignores legacy start_pipeline target aliases", () => {
  const result = deriveDelegationIntentForEarlyCheck({
    action: "start_pipeline",
    pipeline: "t2-loop-platform",
    target: {
      agentId: "researcher",
    },
  });

  assert.equal(result.intentType, "start_pipeline");
  assert.equal(result.targetAgent, null);
});

test("contractor terminal commit updates shared root contract instead of inbox copy", async () => runContractorInboxTestSerial(async () => {
  const contractId = `TC-P0-CONTRACTOR-PATH-${Date.now()}`;
  const contractPath = getContractPath(contractId);
  const inboxDir = join(agentWorkspace("contractor"), "inbox");
  const inboxPath = join(inboxDir, "contract.json");
  const originalInbox = await snapshotFile(inboxPath);

  await mkdir(inboxDir, { recursive: true });

  try {
    const contract = {
      id: contractId,
      task: "shared contract commit regression",
      assignee: "worker",
      status: CONTRACT_STATUS.PENDING,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      phases: [],
      total: 1,
      output: join(agentWorkspace("controller"), "output", `${contractId}.md`),
      protocol: {
        version: 1,
        envelope: "execution_contract",
      },
    };
    await persistContractSnapshot(contractPath, contract, logger);
    await writeFile(inboxPath, JSON.stringify(contract, null, 2), "utf8");

    const trackingState = createTrackingState({
      sessionKey: `agent:contractor:test:${Date.now()}`,
      agentId: "contractor",
      parentSession: null,
    });

    await bindInboxContractEnvelope({
      agentId: "contractor",
      trackingState,
      logger,
      allowNonDirectRequest: true,
    });

    assert.equal(trackingState.contract?.path, contractPath);

    const commitResult = await commitSemanticTerminalState({
      trackingState,
      terminalStatus: CONTRACT_STATUS.COMPLETED,
      outcome: {
        status: CONTRACT_STATUS.COMPLETED,
        source: "system_action",
        reason: "deferred via start_loop",
      },
      logger,
      extraFields: {
        systemAction: {
          type: INTENT_TYPES.START_LOOP,
          status: SYSTEM_ACTION_STATUS.DISPATCHED,
        },
      },
    });

    assert.equal(commitResult.committed, true);

    const sharedContract = JSON.parse(await readFile(contractPath, "utf8"));
    const inboxContract = JSON.parse(await readFile(inboxPath, "utf8"));
    assert.equal(sharedContract.status, CONTRACT_STATUS.COMPLETED);
    assert.equal(sharedContract.systemAction?.type, INTENT_TYPES.START_LOOP);
    assert.equal(inboxContract.status, CONTRACT_STATUS.PENDING);
  } finally {
    await unlink(contractPath).catch(() => {});
    await restoreFile(inboxPath, originalInbox);
  }
}));
