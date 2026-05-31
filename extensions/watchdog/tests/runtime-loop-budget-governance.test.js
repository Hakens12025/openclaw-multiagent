import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { loadGraph } from "../lib/agent/agent-graph.js";
import { saveGraph } from "../lib/agent/agent-graph-mutations.js";
import { getContractPath, persistContractSnapshot } from "../lib/contracts.js";
import { CONTRACT_STATUS } from "../lib/core/runtime-status.js";
import { runAgentEndLifecycle } from "../lib/lifecycle/agent-end-lifecycle.js";
import {
  composeLoopSpecFromAgents,
  loadGraphLoopRegistry,
  saveGraphLoopRegistry,
} from "../lib/loop/graph-loop-registry.js";
import { loadActiveLoopRuntime, startLoopRound } from "../lib/loop/loop-round-runtime.js";
import { LOOP_SESSION_STATE_FILE, loadLoopSessionState } from "../lib/loop/loop-session-store.js";
import { createTrackingState } from "../lib/session-bootstrap.js";
import { agentWorkspace, dispatchOutgoingStateMap, dispatchTargetStateMap, runtimeAgentConfigs } from "../lib/state.js";
import { clearTrackingStore, listTrackingEntries, notifyTrackingContractClaim, rememberTrackingState } from "../lib/store/tracker-store.js";
import { buildInitialTaskStagePlan } from "../lib/task-stage-plan.js";
import { runGlobalTestEnvironmentSerial } from "../lib/formal-runtime/test-locks.js";

const logger = {
  info() {},
  warn() {},
  error() {},
};

const RUNTIME_RESULT_FILENAME = "runtime_result.json";

let uniqueSuffixCounter = 0;

function uniqueSuffix() {
  uniqueSuffixCounter += 1;
  return `${Date.now()}-${process.pid}-${uniqueSuffixCounter}`;
}

function testWithGlobalLoopRuntime(name, fn) {
  test(name, async () => runGlobalTestEnvironmentSerial(fn));
}

async function snapshotFile(path) {
  return readFile(path, "utf8").catch(() => null);
}

async function restoreFile(path, raw) {
  if (raw == null) {
    await rm(path, { force: true });
    return;
  }
  await writeFile(path, raw, "utf8");
}

async function readJsonFile(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function ensureAgentWorkspace(agentId) {
  await mkdir(agentWorkspace(agentId), { recursive: true });
}

function registerLoopRuntimeAgents(agentIds) {
  for (const agentId of Array.isArray(agentIds) ? agentIds : []) {
    runtimeAgentConfigs.set(agentId, {
      id: agentId,
      role: "agent",
      plane: "runtime",
      mainViewVisible: true,
      formalTimelineVisible: true,
      autoWakeEligible: true,
    });
  }
}

function restoreRuntimeAgentConfigs(snapshot) {
  runtimeAgentConfigs.clear();
  for (const [agentId, config] of snapshot.entries()) {
    runtimeAgentConfigs.set(agentId, config);
  }
}

function cloneMapEntries(map) {
  return new Map([...map.entries()].map(([key, value]) => [
    key,
    value && typeof value === "object" ? structuredClone(value) : value,
  ]));
}

function snapshotRuntimeMutableState() {
  return {
    dispatchTargets: cloneMapEntries(dispatchTargetStateMap),
    dispatchOutgoing: cloneMapEntries(dispatchOutgoingStateMap),
    trackingEntries: cloneMapEntries(new Map(listTrackingEntries())),
  };
}

function restoreRuntimeMutableState(snapshot) {
  dispatchTargetStateMap.clear();
  for (const [agentId, state] of snapshot.dispatchTargets.entries()) {
    dispatchTargetStateMap.set(agentId, state);
  }
  dispatchOutgoingStateMap.clear();
  for (const [agentId, state] of snapshot.dispatchOutgoing.entries()) {
    dispatchOutgoingStateMap.set(agentId, state);
  }
  clearTrackingStore();
  for (const [sessionKey, trackingState] of snapshot.trackingEntries.entries()) {
    rememberTrackingState(sessionKey, trackingState);
  }
}

async function cleanAgentBoxes(agentId) {
  for (const box of ["inbox", "outbox", "output"]) {
    const dir = join(agentWorkspace(agentId), box);
    try {
      const files = await readdir(dir);
      await Promise.all(files.map((file) => rm(join(dir, file), { recursive: true, force: true })));
    } catch {}
  }
}

function buildWakeAndClaim() {
  return async (_agentId, payload = {}) => {
    const sessionKey = typeof payload?.sessionKey === "string" ? payload.sessionKey : null;
    const match = sessionKey ? sessionKey.match(/^agent:[^:]+:contract:(.+)$/i) : null;
    const contractId = match?.[1] || null;
    if (sessionKey && contractId) {
      setTimeout(() => {
        notifyTrackingContractClaim(sessionKey, contractId);
      }, 0);
    }
    return { ok: true };
  };
}

function runtimeResultPath(agentId) {
  return join(agentWorkspace(agentId), "outbox", RUNTIME_RESULT_FILENAME);
}

function buildStageResult({
  stage,
  pipelineId = null,
  loopId = null,
  loopSessionId = null,
  round = 1,
  transition = null,
  summary = null,
  feedback = null,
} = {}) {
  return {
    version: 1,
    stage,
    pipelineId,
    loopId,
    loopSessionId,
    round,
    status: "completed",
    summary,
    feedback,
    artifacts: [
      { type: "text_output", path: "result.md", required: false },
    ],
    primaryArtifactPath: "result.md",
    completion: {
      version: 1,
      status: "completed",
      feedback,
      transition,
      deadEnds: [],
    },
    metadata: {},
  };
}

async function completeLoopStageFromContract(agentId, inboxContract, {
  transition,
  summary,
  feedback,
} = {}) {
  const contractPath = getContractPath(inboxContract.id);
  const persistedContract = await readJsonFile(contractPath);
  await persistContractSnapshot(contractPath, {
    ...persistedContract,
    status: CONTRACT_STATUS.RUNNING,
    updatedAt: Date.now(),
  }, logger);

  const outboxDir = join(agentWorkspace(agentId), "outbox");
  await mkdir(outboxDir, { recursive: true });
  await writeFile(join(outboxDir, "result.md"), "# synthetic stage output\n", "utf8");
  await writeFile(runtimeResultPath(agentId), JSON.stringify(buildStageResult({
    stage: inboxContract.pipelineStage?.stage || agentId,
    pipelineId: inboxContract.pipelineStage?.pipelineId || null,
    loopId: inboxContract.pipelineStage?.loopId || null,
    loopSessionId: inboxContract.pipelineStage?.loopSessionId || null,
    round: inboxContract.pipelineStage?.round || 1,
    transition,
    summary,
    feedback,
  }), null, 2), "utf8");

  const trackingState = createTrackingState({
    sessionKey: `synthetic:${agentId}:${inboxContract.id}`,
    agentId,
    parentSession: null,
  });
  trackingState.contract = {
    ...inboxContract,
    path: contractPath,
    status: CONTRACT_STATUS.RUNNING,
  };

  await runAgentEndLifecycle({
    event: {
      success: true,
      synthetic: true,
      protocolBoundary: "canonical_outbox_commit",
      commitType: "runtime_result",
    },
    ctx: {
      sessionKey: trackingState.sessionKey,
      agentId,
    },
    api: {
      runtime: {
        system: {
          requestHeartbeatNow({ sessionKey } = {}) {
            const match = typeof sessionKey === "string"
              ? sessionKey.match(/^agent:[^:]+:contract:(.+)$/i)
              : null;
            const contractId = match?.[1] || null;
            if (sessionKey && contractId) {
              setTimeout(() => {
                notifyTrackingContractClaim(sessionKey, contractId);
              }, 0);
            }
          },
        },
      },
    },
    logger,
    enqueueFn: () => {},
    wakePlanner: async () => null,
    trackingState,
  });

  return readJsonFile(contractPath);
}

async function completeLoopStageWithPlannerOutput(agentId, inboxContract, {
  markdown,
} = {}) {
  const contractPath = getContractPath(inboxContract.id);
  const persistedContract = await readJsonFile(contractPath);
  await persistContractSnapshot(contractPath, {
    ...persistedContract,
    status: CONTRACT_STATUS.RUNNING,
    updatedAt: Date.now(),
  }, logger);

  await writeFile(
    persistedContract.output,
    markdown || [
      "[STAGE] 收敛问题",
      "- 目标：明确任务边界",
      "- 交付：阶段拆解",
      "- 完成标准：下游可继续执行",
      "",
      "[STAGE] 继续执行",
      "- 目标：交给下游节点推进",
      "- 交付：执行路径",
      "- 完成标准：任务继续流动",
      "",
    ].join("\n"),
    "utf8",
  );

  const trackingState = createTrackingState({
    sessionKey: `synthetic:${agentId}:${inboxContract.id}:planner-output`,
    agentId,
    parentSession: null,
  });
  trackingState.contract = {
    ...inboxContract,
    path: contractPath,
    status: CONTRACT_STATUS.RUNNING,
  };

  await runAgentEndLifecycle({
    event: {
      success: true,
      synthetic: true,
      protocolBoundary: "canonical_outbox_commit",
      commitType: "output_only",
    },
    ctx: {
      sessionKey: trackingState.sessionKey,
      agentId,
    },
    api: {
      runtime: {
        system: {
          requestHeartbeatNow({ sessionKey } = {}) {
            const match = typeof sessionKey === "string"
              ? sessionKey.match(/^agent:[^:]+:contract:(.+)$/i)
              : null;
            const contractId = match?.[1] || null;
            if (sessionKey && contractId) {
              setTimeout(() => {
                notifyTrackingContractClaim(sessionKey, contractId);
              }, 0);
            }
          },
        },
      },
    },
    logger,
    enqueueFn: () => {},
    wakePlanner: async () => null,
    trackingState,
  });

  return {
    contract: await readJsonFile(contractPath),
    trackingState,
  };
}

testWithGlobalLoopRuntime("startLoopRound defaults loop runtime budget to three rounds", async () => {
  const suffix = uniqueSuffix();
  const entryAgent = `loop-budget-entry-${suffix}`;
  const peerAgent = `loop-budget-peer-${suffix}`;
  const loopId = `loop-budget-default-${suffix}`;

  const originalGraph = await loadGraph();
  const originalLoopRegistry = await loadGraphLoopRegistry();
  const originalLoopSessionState = await snapshotFile(LOOP_SESSION_STATE_FILE);
  const originalRuntimeAgentConfigs = new Map(runtimeAgentConfigs);
  const originalRuntimeMutableState = snapshotRuntimeMutableState();

  let contractId = null;
  try {
    await Promise.all([
      ensureAgentWorkspace(entryAgent),
      ensureAgentWorkspace(peerAgent),
    ]);
    registerLoopRuntimeAgents([entryAgent, peerAgent]);
    await saveGraph({
      edges: [
        { from: entryAgent, to: peerAgent, label: "loop" },
        { from: peerAgent, to: entryAgent, label: "loop" },
      ],
    });
    await saveGraphLoopRegistry({
      loops: [
        composeLoopSpecFromAgents([entryAgent, peerAgent], {
          id: loopId,
          entryAgentId: entryAgent,
        }),
      ],
    });
    await rm(LOOP_SESSION_STATE_FILE, { force: true });

    const startResult = await startLoopRound({
      loopId,
      startAgent: entryAgent,
      requestedTask: "验证 loop 默认预算",
    }, buildWakeAndClaim(), null, null, logger);
    contractId = startResult?.contractId || null;

    assert.equal(startResult?.action, "started");
    const runtime = await loadActiveLoopRuntime();
    assert.equal(runtime?.budget?.maxRounds, 3);
    assert.equal(runtime?.budget?.maxExperiments, 30);
    assert.equal(runtime?.budget?.usedRounds, 1);
    assert.equal(runtime?.budget?.usedExperiments, 0);
  } finally {
    restoreRuntimeAgentConfigs(originalRuntimeAgentConfigs);
    await saveGraph(originalGraph);
    await saveGraphLoopRegistry(originalLoopRegistry);
    await restoreFile(LOOP_SESSION_STATE_FILE, originalLoopSessionState);
    restoreRuntimeMutableState(originalRuntimeMutableState);
    if (contractId) {
      await rm(getContractPath(contractId), { force: true });
    }
    await rm(agentWorkspace(entryAgent), { recursive: true, force: true });
    await rm(agentWorkspace(peerAgent), { recursive: true, force: true });
  }
});

testWithGlobalLoopRuntime("loop-tagged contracts keep graph routing even when planner only emits stage markers", async () => {
  const suffix = uniqueSuffix();
  const plannerAgent = `loop-planner-${suffix}`;
  const workerAgent = `loop-worker-${suffix}`;
  const loopId = `loop-graph-routing-${suffix}`;

  const originalGraph = await loadGraph();
  const originalLoopRegistry = await loadGraphLoopRegistry();
  const originalLoopSessionState = await snapshotFile(LOOP_SESSION_STATE_FILE);
  const originalRuntimeAgentConfigs = new Map(runtimeAgentConfigs);
  const originalRuntimeMutableState = snapshotRuntimeMutableState();

  let contractId = null;
  try {
    await Promise.all([
      ensureAgentWorkspace(plannerAgent),
      ensureAgentWorkspace(workerAgent),
      cleanAgentBoxes(plannerAgent),
      cleanAgentBoxes(workerAgent),
    ]);
    registerLoopRuntimeAgents([plannerAgent, workerAgent]);
    await saveGraph({
      edges: [
        { from: plannerAgent, to: workerAgent, label: "loop" },
        { from: workerAgent, to: plannerAgent, label: "loop" },
      ],
    });
    await saveGraphLoopRegistry({
      loops: [
        composeLoopSpecFromAgents([plannerAgent, workerAgent], {
          id: loopId,
          entryAgentId: plannerAgent,
        }),
      ],
    });
    await rm(LOOP_SESSION_STATE_FILE, { force: true });

    const startResult = await startLoopRound({
      loopId,
      startAgent: plannerAgent,
      requestedTask: "你好",
    }, buildWakeAndClaim(), null, null, logger);
    contractId = startResult?.contractId || null;

    assert.equal(startResult?.action, "started");

    const plannerInboxContract = await readJsonFile(join(agentWorkspace(plannerAgent), "inbox", "contract.json"));
    assert.equal(plannerInboxContract?.id, contractId);

    const completionResult = await completeLoopStageWithPlannerOutput(plannerAgent, plannerInboxContract);
    const contractAfter = completionResult.contract;
    const workerInboxContract = await readJsonFile(join(agentWorkspace(workerAgent), "inbox", "contract.json"));
    const runtime = await loadActiveLoopRuntime();

    assert.equal(contractAfter?.assignee, workerAgent);
    assert.equal(contractAfter?.pipelineStage?.stage, workerAgent);
    assert.equal(workerInboxContract?.id, contractId);
    assert.equal(workerInboxContract?.pipelineStage?.stage, workerAgent);
    assert.equal(runtime?.currentStage, workerAgent);
    assert.equal(
      contractAfter?.runtimeDiagnostics?.graphRouteProgression?.action,
      "advanced",
    );
  } finally {
    restoreRuntimeAgentConfigs(originalRuntimeAgentConfigs);
    await saveGraph(originalGraph);
    await saveGraphLoopRegistry(originalLoopRegistry);
    await restoreFile(LOOP_SESSION_STATE_FILE, originalLoopSessionState);
    restoreRuntimeMutableState(originalRuntimeMutableState);
    if (contractId) {
      await rm(getContractPath(contractId), { force: true });
    }
    await rm(agentWorkspace(plannerAgent), { recursive: true, force: true });
    await rm(agentWorkspace(workerAgent), { recursive: true, force: true });
  }
});

testWithGlobalLoopRuntime("loop runtime governance concludes when maxExperiments is exhausted by real stage completions", async () => {
  const suffix = uniqueSuffix();
  const entryAgent = `loop-experiments-entry-${suffix}`;
  const peerAgent = `loop-experiments-peer-${suffix}`;
  const loopId = `loop-experiments-${suffix}`;
  const taskStagePlan = buildInitialTaskStagePlan({
    contractId: `TC-LOOP-EXPERIMENTS-${suffix}`,
    stages: ["建立比较维度", "补充关键证据"],
  });

  const originalGraph = await loadGraph();
  const originalLoopRegistry = await loadGraphLoopRegistry();
  const originalLoopSessionState = await snapshotFile(LOOP_SESSION_STATE_FILE);
  const originalRuntimeAgentConfigs = new Map(runtimeAgentConfigs);
  const originalRuntimeMutableState = snapshotRuntimeMutableState();

  let contractId = null;
  try {
    await Promise.all([
      ensureAgentWorkspace(entryAgent),
      ensureAgentWorkspace(peerAgent),
    ]);
    registerLoopRuntimeAgents([entryAgent, peerAgent]);
    await saveGraph({
      edges: [
        { from: entryAgent, to: peerAgent, label: "loop" },
        { from: peerAgent, to: entryAgent, label: "loop" },
      ],
    });
    await saveGraphLoopRegistry({
      loops: [
        composeLoopSpecFromAgents([entryAgent, peerAgent], {
          id: loopId,
          entryAgentId: entryAgent,
        }),
      ],
    });
    await rm(LOOP_SESSION_STATE_FILE, { force: true });
    await Promise.all([cleanAgentBoxes(entryAgent), cleanAgentBoxes(peerAgent)]);

    const startResult = await startLoopRound({
      loopId,
      startAgent: entryAgent,
      requestedTask: "验证 loop runtime maxExperiments 正式收口",
      budget: { maxExperiments: 1 },
      taskStagePlan,
    }, buildWakeAndClaim(), null, null, logger);
    contractId = startResult?.contractId || null;

    assert.equal(startResult?.action, "started");

    const entryContract = await readJsonFile(join(agentWorkspace(entryAgent), "inbox", "contract.json"));
    const terminalContract = await completeLoopStageFromContract(entryAgent, entryContract, {
      transition: { kind: "follow_graph" },
      summary: "entry stage completed",
      feedback: "entry stage completed",
    });

    assert.equal(terminalContract?.status, CONTRACT_STATUS.COMPLETED);
    assert.equal(terminalContract?.terminalOutcome?.source, "loop_runtime_governance");
    assert.equal(terminalContract?.terminalOutcome?.reason, "loop_budget_exhausted:max_experiments");

    const loopSessionState = await loadLoopSessionState();
    assert.equal(loopSessionState?.activeSession, null);
    const concludedSession = loopSessionState?.recentSessions?.[0] || null;
    assert.equal(concludedSession?.loopId, loopId);
    assert.equal(concludedSession?.status, "concluded");
    assert.equal(concludedSession?.concludeReason, "loop_budget_exhausted:max_experiments");
    assert.equal(concludedSession?.budget?.maxExperiments, 1);
    assert.equal(concludedSession?.budget?.usedExperiments, 1);

    await assert.rejects(
      readFile(join(agentWorkspace(peerAgent), "inbox", "contract.json"), "utf8"),
      { code: "ENOENT" },
    );
  } finally {
    restoreRuntimeAgentConfigs(originalRuntimeAgentConfigs);
    await saveGraph(originalGraph);
    await saveGraphLoopRegistry(originalLoopRegistry);
    await restoreFile(LOOP_SESSION_STATE_FILE, originalLoopSessionState);
    restoreRuntimeMutableState(originalRuntimeMutableState);
    if (contractId) {
      await rm(getContractPath(contractId), { force: true });
    }
    await rm(agentWorkspace(entryAgent), { recursive: true, force: true });
    await rm(agentWorkspace(peerAgent), { recursive: true, force: true });
  }
});

testWithGlobalLoopRuntime("loop runtime governance concludes before routing beyond maxRounds", async () => {
  const suffix = uniqueSuffix();
  const entryAgent = `loop-govern-entry-${suffix}`;
  const peerAgent = `loop-govern-peer-${suffix}`;
  const loopId = `loop-governance-${suffix}`;
  const taskStagePlan = buildInitialTaskStagePlan({
    contractId: `TC-LOOP-GOVERN-${suffix}`,
    stages: ["建立比较维度", "补充关键证据", "形成结论"],
  });

  const originalGraph = await loadGraph();
  const originalLoopRegistry = await loadGraphLoopRegistry();
  const originalLoopSessionState = await snapshotFile(LOOP_SESSION_STATE_FILE);
  const originalRuntimeAgentConfigs = new Map(runtimeAgentConfigs);
  const originalRuntimeMutableState = snapshotRuntimeMutableState();

  let contractId = null;
  try {
    await Promise.all([
      ensureAgentWorkspace(entryAgent),
      ensureAgentWorkspace(peerAgent),
    ]);
    registerLoopRuntimeAgents([entryAgent, peerAgent]);
    await saveGraph({
      edges: [
        { from: entryAgent, to: peerAgent, label: "loop" },
        { from: peerAgent, to: entryAgent, label: "loop" },
      ],
    });
    await saveGraphLoopRegistry({
      loops: [
        composeLoopSpecFromAgents([entryAgent, peerAgent], {
          id: loopId,
          entryAgentId: entryAgent,
        }),
      ],
    });
    await rm(LOOP_SESSION_STATE_FILE, { force: true });
    await Promise.all([cleanAgentBoxes(entryAgent), cleanAgentBoxes(peerAgent)]);

    const startResult = await startLoopRound({
      loopId,
      startAgent: entryAgent,
      requestedTask: "验证 loop runtime maxRounds 正式收口",
      budget: { maxRounds: 1 },
      taskStagePlan,
    }, buildWakeAndClaim(), null, null, logger);
    contractId = startResult?.contractId || null;

    assert.equal(startResult?.action, "started");

    const entryContract = await readJsonFile(join(agentWorkspace(entryAgent), "inbox", "contract.json"));
    await completeLoopStageFromContract(entryAgent, entryContract, {
      transition: { kind: "follow_graph" },
      summary: "entry stage completed",
      feedback: "entry stage completed",
    });

    const runtimeAfterFirstAdvance = await loadActiveLoopRuntime();
    assert.equal(runtimeAfterFirstAdvance?.currentStage, peerAgent);
    assert.equal(runtimeAfterFirstAdvance?.round, 1);
    assert.equal(runtimeAfterFirstAdvance?.budget?.maxRounds, 1);
    assert.equal(runtimeAfterFirstAdvance?.budget?.usedRounds, 1);

    const peerContract = await readJsonFile(join(agentWorkspace(peerAgent), "inbox", "contract.json"));
    const terminalContract = await completeLoopStageFromContract(peerAgent, peerContract, {
      transition: { kind: "follow_graph" },
      summary: "peer stage completed",
      feedback: "peer stage completed",
    });

    assert.equal(terminalContract?.status, CONTRACT_STATUS.COMPLETED);
    assert.equal(terminalContract?.terminalOutcome?.source, "loop_runtime_governance");
    assert.equal(terminalContract?.terminalOutcome?.reason, "loop_budget_exhausted:max_rounds");

    const loopSessionState = await loadLoopSessionState();
    assert.equal(loopSessionState?.activeSession, null);
    const concludedSession = loopSessionState?.recentSessions?.[0] || null;
    assert.equal(concludedSession?.loopId, loopId);
    assert.equal(concludedSession?.status, "concluded");
    assert.equal(concludedSession?.concludeReason, "loop_budget_exhausted:max_rounds");
    assert.equal(concludedSession?.budget?.maxRounds, 1);
    assert.equal(concludedSession?.budget?.usedRounds, 1);

    await assert.rejects(
      readFile(join(agentWorkspace(entryAgent), "inbox", "contract.json"), "utf8"),
      { code: "ENOENT" },
    );
  } finally {
    restoreRuntimeAgentConfigs(originalRuntimeAgentConfigs);
    await saveGraph(originalGraph);
    await saveGraphLoopRegistry(originalLoopRegistry);
    await restoreFile(LOOP_SESSION_STATE_FILE, originalLoopSessionState);
    restoreRuntimeMutableState(originalRuntimeMutableState);
    if (contractId) {
      await rm(getContractPath(contractId), { force: true });
    }
    await rm(agentWorkspace(entryAgent), { recursive: true, force: true });
    await rm(agentWorkspace(peerAgent), { recursive: true, force: true });
  }
});
