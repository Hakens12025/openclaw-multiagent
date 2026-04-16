import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { loadGraph, saveGraph } from "../lib/agent/agent-graph.js";
import { getContractPath, persistContractSnapshot } from "../lib/contracts.js";
import { CONTRACT_STATUS } from "../lib/core/runtime-status.js";
import { runAgentEndPipeline } from "../lib/lifecycle/agent-end-pipeline.js";
import {
  composeLoopSpecFromAgents,
  loadGraphLoopRegistry,
  saveGraphLoopRegistry,
} from "../lib/loop/graph-loop-registry.js";
import { loadActiveLoopRuntime, interruptLoopRound, resumeLoopRound, startLoopRound } from "../lib/loop/loop-round-runtime.js";
import { LOOP_SESSION_STATE_FILE, loadLoopSessionState } from "../lib/loop/loop-session-store.js";
import { createTrackingState } from "../lib/session-bootstrap.js";
import { agentWorkspace } from "../lib/state.js";
import { applyTrackingStageProjection } from "../lib/stage-projection.js";
import { buildInitialTaskStagePlan } from "../lib/task-stage-plan.js";
import { runGlobalTestEnvironmentSerial } from "./test-locks.js";

const logger = {
  info() {},
  warn() {},
  error() {},
};

const STAGE_RESULT_FILENAME = "stage_result.json";

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

async function ensureAgentWorkspaces(agentIds) {
  await Promise.all((Array.isArray(agentIds) ? agentIds : []).map((agentId) => (
    mkdir(agentWorkspace(agentId), { recursive: true })
  )));
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

async function cleanOutbox(agentId) {
  const dir = join(agentWorkspace(agentId), "outbox");
  try {
    const files = await readdir(dir);
    await Promise.all(files.map((file) => rm(join(dir, file), { recursive: true, force: true })));
  } catch {}
}

function stageResultPath(agentId) {
  return join(agentWorkspace(agentId), "outbox", STAGE_RESULT_FILENAME);
}

function buildStageResult({
  stage,
  pipelineId = null,
  loopId = null,
  loopSessionId = null,
  round = 1,
  status = "completed",
  artifacts = [],
  primaryArtifactPath = null,
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
    status,
    summary,
    feedback,
    artifacts,
    primaryArtifactPath,
    completion: {
      version: 1,
      status,
      feedback,
      transition,
      deadEnds: [],
    },
    metadata: {},
  };
}

function stageResultManifest(extraArtifacts = []) {
  return {
    version: 1,
    kind: "stage_result",
    artifacts: [
      { type: "stage_result", path: STAGE_RESULT_FILENAME, required: true },
      ...extraArtifacts,
    ],
  };
}

async function completeLoopStage(agentId, {
  transition,
  summary,
  feedback,
  primaryArtifactName = "result.md",
  primaryArtifactBody = "# synthetic stage output\n\nloop semantic projection test.\n",
} = {}) {
  const inboxContract = await readJsonFile(join(agentWorkspace(agentId), "inbox", "contract.json"));
  return completeLoopStageFromContract(agentId, inboxContract, {
    transition,
    summary,
    feedback,
    primaryArtifactName,
    primaryArtifactBody,
  });
}

async function completeLoopStageFromContract(agentId, inboxContract, {
  transition,
  summary,
  feedback,
  primaryArtifactName = "result.md",
  primaryArtifactBody = "# synthetic stage output\n\nloop semantic projection test.\n",
  persistRunningStatus = true,
} = {}) {
  const contractPath = getContractPath(inboxContract.id);
  if (persistRunningStatus) {
    const persistedContract = await readJsonFile(contractPath);
    await persistContractSnapshot(contractPath, {
      ...persistedContract,
      status: CONTRACT_STATUS.RUNNING,
      updatedAt: Date.now(),
    }, logger);
  }

  const outboxDir = join(agentWorkspace(agentId), "outbox");
  await mkdir(outboxDir, { recursive: true });
  await cleanOutbox(agentId);
  await writeFile(join(outboxDir, "_manifest.json"), JSON.stringify(stageResultManifest([
    { type: "text_output", path: primaryArtifactName, required: false },
  ]), null, 2), "utf8");
  await writeFile(join(outboxDir, primaryArtifactName), primaryArtifactBody, "utf8");
  await writeFile(stageResultPath(agentId), JSON.stringify(buildStageResult({
    stage: inboxContract.pipelineStage?.stage || agentId,
    pipelineId: inboxContract.pipelineStage?.pipelineId || null,
    loopId: inboxContract.pipelineStage?.loopId || null,
    loopSessionId: inboxContract.pipelineStage?.loopSessionId || null,
    round: inboxContract.pipelineStage?.round || 1,
    status: "completed",
    artifacts: [
      { type: "text_output", path: primaryArtifactName, required: false },
    ],
    primaryArtifactPath: primaryArtifactName,
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

  await runAgentEndPipeline({
    event: {
      success: true,
      synthetic: true,
      protocolBoundary: "canonical_outbox_commit",
      commitType: "stage_result",
    },
    ctx: {
      sessionKey: trackingState.sessionKey,
      agentId,
    },
    api: {
      runtime: {
        system: {
          requestHeartbeatNow() {},
        },
      },
    },
    logger,
    enqueueFn: () => {},
    wakePlanner: async () => null,
    trackingState,
  });

  return {
    inboxContract,
    contractAfter: await readJsonFile(contractPath),
    trackingState,
  };
}

test("composeLoopSpecFromAgents defaults loops to task stage truth mode", () => {
  const loop = composeLoopSpecFromAgents(["researcher", "worker-d", "evaluator"]);

  assert.equal(loop?.metadata?.semanticStageMode, "task_stage_truth");
});

testWithGlobalLoopRuntime("startLoopRound carries canonical task stage truth into loop runtime and shared contract", async () => {
  const suffix = `${Date.now()}`;
  const researcher = `loop-semantic-researcher-${suffix}`;
  const worker = `loop-semantic-worker-${suffix}`;
  const evaluator = `loop-semantic-evaluator-${suffix}`;
  const loopId = `loop-semantic-${suffix}`;
  const taskStagePlan = buildInitialTaskStagePlan({
    contractId: `TC-LOOP-SEMANTIC-${suffix}`,
    stages: ["建立比较维度", "补充关键证据", "形成结论"],
  });

  const originalGraph = await loadGraph();
  const originalLoopRegistry = await loadGraphLoopRegistry();
  const loopSessionStateRaw = await snapshotFile(LOOP_SESSION_STATE_FILE);

  let startResult = null;
  try {
    await ensureAgentWorkspaces([researcher, worker, evaluator]);
    await saveGraph({
      edges: [
        { from: researcher, to: worker, label: "research" },
        { from: worker, to: evaluator, label: "build" },
        { from: evaluator, to: researcher, label: "review" },
      ],
    });
    await saveGraphLoopRegistry({
      loops: [
        composeLoopSpecFromAgents([researcher, worker, evaluator], {
          id: loopId,
          entryAgentId: researcher,
        }),
      ],
    });
    await rm(LOOP_SESSION_STATE_FILE, { force: true });

    startResult = await startLoopRound(
      {
        loopId,
        startAgent: researcher,
        requestedTask: "验证 loop 语义 stage 真值链路",
        taskStagePlan,
      },
      null,
      null,
      null,
      logger,
    );

    assert.equal(startResult?.action, "started");

    const runtime = await loadActiveLoopRuntime();
    assert.equal(runtime?.semanticStageMode, "task_stage_truth");
    assert.deepEqual(
      runtime?.taskStagePlan?.stages?.map((entry) => entry.label),
      ["建立比较维度", "补充关键证据", "形成结论"],
    );
    assert.equal(runtime?.taskStageRuntime?.currentStageId, "stage-1");
    assert.deepEqual(runtime?.taskStageRuntime?.completedStageIds, []);

    const contract = await readJsonFile(getContractPath(startResult.contractId));
    assert.equal(contract?.pipelineStage?.semanticStageId, "stage-1");
    assert.deepEqual(
      contract?.stagePlan?.stages?.map((entry) => entry.label),
      ["建立比较维度", "补充关键证据", "形成结论"],
    );
    assert.equal(contract?.stageRuntime?.currentStageId, "stage-1");
    assert.deepEqual(contract?.stageRuntime?.completedStageIds, []);
    assert.deepEqual(contract?.phases, ["建立比较维度", "补充关键证据", "形成结论"]);
    assert.equal(contract?.total, 3);

    await assert.rejects(
      readFile(join(agentWorkspace(researcher), "inbox", "context.json"), "utf8"),
      { code: "ENOENT" },
    );
  } finally {
    await saveGraph(originalGraph);
    await saveGraphLoopRegistry(originalLoopRegistry);
    await restoreFile(LOOP_SESSION_STATE_FILE, loopSessionStateRaw);
    if (startResult?.contractId) {
      await rm(getContractPath(startResult.contractId), { force: true });
    }
    await rm(agentWorkspace(researcher), { recursive: true, force: true });
    await rm(agentWorkspace(worker), { recursive: true, force: true });
    await rm(agentWorkspace(evaluator), { recursive: true, force: true });
  }
});

testWithGlobalLoopRuntime("startLoopRound falls back to the shared task stage planner when no task stage plan is supplied", async () => {
  const suffix = `${Date.now()}`;
  const researcher = `loop-fallback-researcher-${suffix}`;
  const worker = `loop-fallback-worker-${suffix}`;
  const evaluator = `loop-fallback-evaluator-${suffix}`;
  const loopId = `loop-fallback-${suffix}`;

  const originalGraph = await loadGraph();
  const originalLoopRegistry = await loadGraphLoopRegistry();
  const loopSessionStateRaw = await snapshotFile(LOOP_SESSION_STATE_FILE);

  let startResult = null;
  try {
    await ensureAgentWorkspaces([researcher, worker, evaluator]);
    await saveGraph({
      edges: [
        { from: researcher, to: worker, label: "research" },
        { from: worker, to: evaluator, label: "build" },
        { from: evaluator, to: researcher, label: "review" },
      ],
    });
    await saveGraphLoopRegistry({
      loops: [
        composeLoopSpecFromAgents([researcher, worker, evaluator], {
          id: loopId,
          entryAgentId: researcher,
        }),
      ],
    });
    await rm(LOOP_SESSION_STATE_FILE, { force: true });

    startResult = await startLoopRound(
      {
        loopId,
        startAgent: researcher,
        requestedTask: "对比三个框架优缺点",
      },
      null,
      null,
      null,
      logger,
    );

    assert.equal(startResult?.action, "started");

    const runtime = await loadActiveLoopRuntime();
    assert.deepEqual(
      runtime?.taskStagePlan?.stages?.map((entry) => entry.label),
      ["执行"],
    );
    assert.equal(runtime?.taskStageRuntime?.currentStageId, "stage-1");
    assert.deepEqual(runtime?.taskStageRuntime?.completedStageIds, []);

    const contract = await readJsonFile(getContractPath(startResult.contractId));
    assert.deepEqual(contract?.phases, ["执行"]);
    assert.deepEqual(
      contract?.stagePlan?.stages?.map((entry) => entry.label),
      ["执行"],
    );
    assert.equal(contract?.stageRuntime?.currentStageId, "stage-1");
    assert.deepEqual(contract?.stageRuntime?.completedStageIds, []);
  } finally {
    await saveGraph(originalGraph);
    await saveGraphLoopRegistry(originalLoopRegistry);
    await restoreFile(LOOP_SESSION_STATE_FILE, loopSessionStateRaw);
    if (startResult?.contractId) {
      await rm(getContractPath(startResult.contractId), { force: true });
    }
    await rm(agentWorkspace(researcher), { recursive: true, force: true });
    await rm(agentWorkspace(worker), { recursive: true, force: true });
    await rm(agentWorkspace(evaluator), { recursive: true, force: true });
  }
});

test("applyTrackingStageProjection shows semantic task stages in loop context when explicit semantic truth is present", () => {
  const trackingState = createTrackingState({
    sessionKey: `agent:worker-d:loop-semantic-stage-projection:${Date.now()}`,
    agentId: "worker-d",
    parentSession: null,
  });
  trackingState.contract = {
    id: `TC-LOOP-SEMANTIC-STAGE-PROJECTION-${Date.now()}`,
    task: "loop projection should show semantic task stages",
    status: CONTRACT_STATUS.RUNNING,
    stagePlan: {
      version: 2,
      stages: [
        { id: "stage-1", label: "建立比较维度", semanticLabel: "建立比较维度", status: "completed" },
        { id: "stage-2", label: "补充关键证据", semanticLabel: "补充关键证据", status: "active" },
        { id: "stage-3", label: "形成结论", semanticLabel: "形成结论", status: "pending" },
      ],
      revisionPolicy: { maxRevisions: 2, maxStageDelta: 1 },
    },
    stageRuntime: {
      version: 1,
      currentStageId: "stage-2",
      completedStageIds: ["stage-1"],
      revisionCount: 0,
      lastRevisionReason: null,
    },
    pipelineStage: {
      pipelineId: "pipe-loop-semantic-stage-projection",
      loopSessionId: "LS-loop-semantic-stage-projection",
      stage: "researcher",
      semanticStageId: "stage-2",
      round: 2,
    },
  };

  const projection = applyTrackingStageProjection(trackingState);

  assert.equal(projection?.source, "task_stage_truth");
  assert.equal(projection?.currentStageLabel, "补充关键证据");
  assert.equal(projection?.round, null);
  assert.deepEqual(projection?.stagePlan, ["建立比较维度", "补充关键证据", "形成结论"]);
});

testWithGlobalLoopRuntime("graph-routed stage_result carries runtime-observed stage truth forward into the next loop stage contract", async () => {
  const suffix = `${Date.now()}`;
  const researcher = `loop-semantic-advance-researcher-${suffix}`;
  const worker = `loop-semantic-advance-worker-${suffix}`;
  const evaluator = `loop-semantic-advance-evaluator-${suffix}`;
  const loopId = `loop-semantic-advance-${suffix}`;
  const taskStagePlan = buildInitialTaskStagePlan({
    contractId: `TC-LOOP-ADVANCE-${suffix}`,
    stages: ["建立比较维度", "补充关键证据", "形成结论"],
  });

  const originalGraph = await loadGraph();
  const originalLoopRegistry = await loadGraphLoopRegistry();
  const loopSessionStateRaw = await snapshotFile(LOOP_SESSION_STATE_FILE);

  let startResult = null;
  try {
    await ensureAgentWorkspaces([researcher, worker, evaluator]);
    await saveGraph({
      edges: [
        { from: researcher, to: worker, label: "research" },
        { from: worker, to: evaluator, label: "build" },
        { from: evaluator, to: researcher, label: "review" },
      ],
    });
    await saveGraphLoopRegistry({
      loops: [
        composeLoopSpecFromAgents([researcher, worker, evaluator], {
          id: loopId,
          entryAgentId: researcher,
        }),
      ],
    });
    await rm(LOOP_SESSION_STATE_FILE, { force: true });

    startResult = await startLoopRound(
      {
        loopId,
        startAgent: researcher,
        requestedTask: "验证 loop 语义 stage 运行态延续",
        taskStagePlan,
      },
      null,
      null,
      null,
      logger,
    );

    assert.equal(startResult?.action, "started");

    const { contractAfter } = await completeLoopStage(researcher, {
      transition: {
        kind: "advance",
        targetStage: worker,
      },
      summary: "阶段一已完成，进入证据补充",
      feedback: "进入下一语义阶段",
      primaryArtifactName: "loop-stage-advance-output.md",
      primaryArtifactBody: "# stage-1\n\n阶段一已完成，进入证据补充。\n",
    });

    const runtime = await loadActiveLoopRuntime();
    assert.equal(runtime?.currentStage, worker);
    assert.equal(runtime?.taskStageRuntime?.currentStageId, "stage-2");
    assert.deepEqual(runtime?.taskStageRuntime?.completedStageIds, ["stage-1"]);
    assert.match(
      runtime?.feedbackOutput?.executionObservation?.stageRunResult?.primaryArtifactPath || "",
      /loop-stage-advance-output\.md$/,
    );
    assert.equal(runtime?.feedbackOutput?.executionObservation?.stageCompletion?.feedback, "进入下一语义阶段");

    const loopSessionState = await loadLoopSessionState();
    assert.equal(loopSessionState?.activeSession?.taskStageRuntime?.currentStageId, "stage-2");
    assert.deepEqual(loopSessionState?.activeSession?.taskStageRuntime?.completedStageIds, ["stage-1"]);

    const workerContract = await readJsonFile(join(agentWorkspace(worker), "inbox", "contract.json"));
    assert.equal(workerContract?.id, startResult.contractId);
    assert.equal(workerContract?.pipelineStage?.semanticStageId, "stage-2");
    assert.equal(workerContract?.stageRuntime?.currentStageId, "stage-2");
    assert.deepEqual(workerContract?.stageRuntime?.completedStageIds, ["stage-1"]);
    assert.match(workerContract?.pipelineStage?.previousArtifactPath || "", /loop-stage-advance-output\.md$/);
    assert.match(workerContract?.pipelineStage?.previousFeedback || "", /阶段一已完成/);

    assert.match(contractAfter?.executionObservation?.stageRunResult?.summary || "", /阶段一已完成/);

    await assert.rejects(
      readFile(join(agentWorkspace(worker), "inbox", "context.json"), "utf8"),
      { code: "ENOENT" },
    );
  } finally {
    await saveGraph(originalGraph);
    await saveGraphLoopRegistry(originalLoopRegistry);
    await restoreFile(LOOP_SESSION_STATE_FILE, loopSessionStateRaw);
    if (startResult?.contractId) {
      await rm(getContractPath(startResult.contractId), { force: true });
    }
    await rm(agentWorkspace(researcher), { recursive: true, force: true });
    await rm(agentWorkspace(worker), { recursive: true, force: true });
    await rm(agentWorkspace(evaluator), { recursive: true, force: true });
  }
});

testWithGlobalLoopRuntime("graph-routed concluded stage_result preserves final runtime-observed stage truth in loop session history", async () => {
  const suffix = `${Date.now()}`;
  const researcher = `loop-semantic-conclude-researcher-${suffix}`;
  const worker = `loop-semantic-conclude-worker-${suffix}`;
  const evaluator = `loop-semantic-conclude-evaluator-${suffix}`;
  const loopId = `loop-semantic-conclude-${suffix}`;
  const taskStagePlan = buildInitialTaskStagePlan({
    contractId: `TC-LOOP-CONCLUDE-${suffix}`,
    stages: ["执行"],
  });

  const originalGraph = await loadGraph();
  const originalLoopRegistry = await loadGraphLoopRegistry();
  const loopSessionStateRaw = await snapshotFile(LOOP_SESSION_STATE_FILE);

  let startResult = null;
  try {
    await ensureAgentWorkspaces([researcher, worker, evaluator]);
    await saveGraph({
      edges: [
        { from: researcher, to: worker, label: "research" },
        { from: worker, to: evaluator, label: "build" },
        { from: evaluator, to: researcher, label: "review" },
      ],
    });
    await saveGraphLoopRegistry({
      loops: [
        composeLoopSpecFromAgents([researcher, worker, evaluator], {
          id: loopId,
          entryAgentId: researcher,
        }),
      ],
    });
    await rm(LOOP_SESSION_STATE_FILE, { force: true });

    startResult = await startLoopRound(
      {
        loopId,
        startAgent: researcher,
        requestedTask: "验证 conclude 路径保留最终语义 stage 真值",
        taskStagePlan,
      },
      null,
      null,
      null,
      logger,
    );

    await completeLoopStage(researcher, {
      transition: {
        kind: "conclude",
      },
      summary: "唯一语义阶段已完成",
      feedback: "合同可以结束",
      primaryArtifactName: "loop-stage-conclude-output.md",
      primaryArtifactBody: "# complete\n\n唯一语义阶段已完成。\n",
    });

    const loopSessionState = await loadLoopSessionState();
    const concludedSession = loopSessionState?.recentSessions?.[0] || null;
    assert.equal((await loadActiveLoopRuntime()), null);
    assert.equal(concludedSession?.taskStageRuntime?.currentStageId, null);
    assert.deepEqual(concludedSession?.taskStageRuntime?.completedStageIds, ["stage-1"]);
  } finally {
    await saveGraph(originalGraph);
    await saveGraphLoopRegistry(originalLoopRegistry);
    await restoreFile(LOOP_SESSION_STATE_FILE, loopSessionStateRaw);
    if (startResult?.contractId) {
      await rm(getContractPath(startResult.contractId), { force: true });
    }
    await rm(agentWorkspace(researcher), { recursive: true, force: true });
    await rm(agentWorkspace(worker), { recursive: true, force: true });
    await rm(agentWorkspace(evaluator), { recursive: true, force: true });
  }
});

testWithGlobalLoopRuntime("resumeLoopRound re-dispatches the active stage as a shared contract without recreating loop context sidecars", async () => {
  const suffix = `${Date.now()}`;
  const researcher = `loop-resume-researcher-${suffix}`;
  const worker = `loop-resume-worker-${suffix}`;
  const evaluator = `loop-resume-evaluator-${suffix}`;
  const loopId = `loop-resume-${suffix}`;
  const taskStagePlan = buildInitialTaskStagePlan({
    contractId: `TC-LOOP-RESUME-${suffix}`,
    stages: ["建立比较维度", "补充关键证据"],
  });

  const originalGraph = await loadGraph();
  const originalLoopRegistry = await loadGraphLoopRegistry();
  const loopSessionStateRaw = await snapshotFile(LOOP_SESSION_STATE_FILE);

  let startResult = null;
  let resumeResult = null;
  try {
    await ensureAgentWorkspaces([researcher, worker, evaluator]);
    await saveGraph({
      edges: [
        { from: researcher, to: worker, label: "research" },
        { from: worker, to: evaluator, label: "build" },
        { from: evaluator, to: researcher, label: "review" },
      ],
    });
    await saveGraphLoopRegistry({
      loops: [
        composeLoopSpecFromAgents([researcher, worker, evaluator], {
          id: loopId,
          entryAgentId: researcher,
        }),
      ],
    });
    await rm(LOOP_SESSION_STATE_FILE, { force: true });

    startResult = await startLoopRound(
      {
        loopId,
        startAgent: researcher,
        requestedTask: "验证 resume 重新投递 contract，而不是重写 loop context",
        taskStagePlan,
      },
      null,
      null,
      null,
      logger,
    );

    const interruptResult = await interruptLoopRound({ loopId, reason: "resume_test_interrupt" }, logger);
    assert.equal(interruptResult?.action, "interrupted");

    resumeResult = await resumeLoopRound({ loopId, reason: "resume_test" }, null, logger);
    assert.equal(resumeResult?.action, "resumed");
    assert.ok(resumeResult?.contractId);

    const resumedRuntime = await loadActiveLoopRuntime();
    assert.deepEqual(
      resumedRuntime?.taskStagePlan?.stages?.map((entry) => entry.label),
      ["建立比较维度", "补充关键证据"],
    );
    assert.equal(resumedRuntime?.taskStageRuntime?.currentStageId, "stage-1");

    const resumedLoopSessionState = await loadLoopSessionState();
    assert.ok(resumedLoopSessionState?.activeSession?.resumeFromLoopSessionId);

    const resumedContract = await readJsonFile(getContractPath(resumeResult.contractId));
    assert.equal(resumedContract?.pipelineStage?.stage, researcher);
    assert.equal(resumedContract?.pipelineStage?.semanticStageId, "stage-1");
    assert.deepEqual(
      resumedContract?.stagePlan?.stages?.map((entry) => entry.label),
      ["建立比较维度", "补充关键证据"],
    );
    assert.equal(resumedContract?.stageRuntime?.currentStageId, "stage-1");

    await assert.rejects(
      readFile(join(agentWorkspace(researcher), "inbox", "context.json"), "utf8"),
      { code: "ENOENT" },
    );
  } finally {
    await saveGraph(originalGraph);
    await saveGraphLoopRegistry(originalLoopRegistry);
    await restoreFile(LOOP_SESSION_STATE_FILE, loopSessionStateRaw);
    if (startResult?.contractId) {
      await rm(getContractPath(startResult.contractId), { force: true });
    }
    if (resumeResult?.contractId) {
      await rm(getContractPath(resumeResult.contractId), { force: true });
    }
    await rm(agentWorkspace(researcher), { recursive: true, force: true });
    await rm(agentWorkspace(worker), { recursive: true, force: true });
    await rm(agentWorkspace(evaluator), { recursive: true, force: true });
  }
});

testWithGlobalLoopRuntime("interruptLoopRound terminalizes the active loop contract and clears staged inbox", async () => {
  const suffix = `${Date.now()}`;
  const researcher = `loop-interrupt-researcher-${suffix}`;
  const worker = `loop-interrupt-worker-${suffix}`;
  const evaluator = `loop-interrupt-evaluator-${suffix}`;
  const loopId = `loop-interrupt-${suffix}`;

  const originalGraph = await loadGraph();
  const originalLoopRegistry = await loadGraphLoopRegistry();
  const loopSessionStateRaw = await snapshotFile(LOOP_SESSION_STATE_FILE);

  let startResult = null;
  try {
    await ensureAgentWorkspaces([researcher, worker, evaluator]);
    await saveGraph({
      edges: [
        { from: researcher, to: worker, label: "research" },
        { from: worker, to: evaluator, label: "build" },
        { from: evaluator, to: researcher, label: "review" },
      ],
    });
    await saveGraphLoopRegistry({
      loops: [
        composeLoopSpecFromAgents([researcher, worker, evaluator], {
          id: loopId,
          entryAgentId: researcher,
        }),
      ],
    });
    await rm(LOOP_SESSION_STATE_FILE, { force: true });

    startResult = await startLoopRound({
      loopId,
      startAgent: researcher,
      requestedTask: "验证 interrupt 后 loop 合同会被终态化并清掉 inbox",
    }, null, null, null, logger);

    assert.equal(startResult?.action, "started");
    const contractPath = getContractPath(startResult.contractId);

    const interruptResult = await interruptLoopRound({
      loopId,
      reason: "interrupt_cleanup_test",
    }, logger);

    assert.equal(interruptResult?.action, "interrupted");

    const interruptedContract = await readJsonFile(contractPath);
    assert.equal(interruptedContract?.status, CONTRACT_STATUS.CANCELLED);
    assert.equal(interruptedContract?.terminalOutcome?.status, CONTRACT_STATUS.CANCELLED);
    assert.match(interruptedContract?.terminalOutcome?.reason || "", /interrupt_cleanup_test/);

    await assert.rejects(
      readFile(join(agentWorkspace(researcher), "inbox", "contract.json"), "utf8"),
      { code: "ENOENT" },
    );

    const loopSessionState = await loadLoopSessionState();
    assert.equal(loopSessionState?.activeSession, null);
    assert.equal(loopSessionState?.recentSessions?.[0]?.status, "interrupted");
  } finally {
    await saveGraph(originalGraph);
    await saveGraphLoopRegistry(originalLoopRegistry);
    await restoreFile(LOOP_SESSION_STATE_FILE, loopSessionStateRaw);
    if (startResult?.contractId) {
      await rm(getContractPath(startResult.contractId), { force: true });
    }
    await rm(agentWorkspace(researcher), { recursive: true, force: true });
    await rm(agentWorkspace(worker), { recursive: true, force: true });
    await rm(agentWorkspace(evaluator), { recursive: true, force: true });
  }
});

testWithGlobalLoopRuntime("late completion after interrupt does not reroute loop-tagged shared contract", async () => {
  const suffix = `${Date.now()}`;
  const researcher = `loop-late-researcher-${suffix}`;
  const worker = `loop-late-worker-${suffix}`;
  const evaluator = `loop-late-evaluator-${suffix}`;
  const loopId = `loop-late-${suffix}`;

  const originalGraph = await loadGraph();
  const originalLoopRegistry = await loadGraphLoopRegistry();
  const loopSessionStateRaw = await snapshotFile(LOOP_SESSION_STATE_FILE);

  let startResult = null;
  try {
    await ensureAgentWorkspaces([researcher, worker, evaluator]);
    await saveGraph({
      edges: [
        { from: researcher, to: worker, label: "research" },
        { from: worker, to: evaluator, label: "build" },
        { from: evaluator, to: researcher, label: "review" },
      ],
    });
    await saveGraphLoopRegistry({
      loops: [
        composeLoopSpecFromAgents([researcher, worker, evaluator], {
          id: loopId,
          entryAgentId: researcher,
        }),
      ],
    });
    await rm(LOOP_SESSION_STATE_FILE, { force: true });

    startResult = await startLoopRound({
      loopId,
      startAgent: researcher,
      requestedTask: "验证 interrupt 之后，迟到完成不会继续沿 graph-router 派发",
    }, null, null, null, logger);
    assert.equal(startResult?.action, "started");

    await completeLoopStage(researcher, {
      transition: { kind: "follow_graph", reason: "stage_completed" },
      summary: "researcher stage complete",
      feedback: "researcher stage complete",
    });

    const workerInboxContract = await readJsonFile(join(agentWorkspace(worker), "inbox", "contract.json"));
    const contractPath = getContractPath(workerInboxContract.id);

    const interruptResult = await interruptLoopRound({
      loopId,
      reason: "interrupt_blocks_late_completion",
    }, logger);
    assert.equal(interruptResult?.action, "interrupted");

    const interruptedContract = await readJsonFile(contractPath);
    assert.equal(interruptedContract?.status, CONTRACT_STATUS.CANCELLED);

    const lateCompletion = await completeLoopStageFromContract(worker, workerInboxContract, {
      transition: { kind: "follow_graph", reason: "stage_completed" },
      summary: "worker late completion",
      feedback: "worker late completion",
      persistRunningStatus: false,
    });

    const contractAfterLateCompletion = await readJsonFile(contractPath);
    assert.equal(contractAfterLateCompletion?.status, CONTRACT_STATUS.CANCELLED);
    assert.equal(contractAfterLateCompletion?.pipelineStage?.stage, worker);

    await assert.rejects(
      readFile(join(agentWorkspace(evaluator), "inbox", "contract.json"), "utf8"),
      { code: "ENOENT" },
    );

    assert.notEqual(lateCompletion?.contractAfter?.assignee, evaluator);
  } finally {
    await saveGraph(originalGraph);
    await saveGraphLoopRegistry(originalLoopRegistry);
    await restoreFile(LOOP_SESSION_STATE_FILE, loopSessionStateRaw);
    if (startResult?.contractId) {
      await rm(getContractPath(startResult.contractId), { force: true });
    }
    await rm(agentWorkspace(researcher), { recursive: true, force: true });
    await rm(agentWorkspace(worker), { recursive: true, force: true });
    await rm(agentWorkspace(evaluator), { recursive: true, force: true });
  }
});
