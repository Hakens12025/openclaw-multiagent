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
import { loadActiveLoopRuntime, startLoopRound } from "../lib/loop/loop-round-runtime.js";
import { LOOP_SESSION_STATE_FILE, loadLoopSessionState } from "../lib/loop/loop-session-store.js";
import { createTrackingState } from "../lib/session-bootstrap.js";
import { agentWorkspace } from "../lib/state.js";
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

async function ensureAgentWorkspace(agentId) {
  await mkdir(agentWorkspace(agentId), { recursive: true });
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

function stageResultPath(agentId) {
  return join(agentWorkspace(agentId), "outbox", STAGE_RESULT_FILENAME);
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
  await writeFile(join(outboxDir, "_manifest.json"), JSON.stringify({
    version: 1,
    kind: "stage_result",
    artifacts: [
      { type: "stage_result", path: STAGE_RESULT_FILENAME, required: true },
      { type: "text_output", path: "result.md", required: false },
    ],
  }, null, 2), "utf8");
  await writeFile(join(outboxDir, "result.md"), "# synthetic stage output\n", "utf8");
  await writeFile(stageResultPath(agentId), JSON.stringify(buildStageResult({
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

  return readJsonFile(contractPath);
}

testWithGlobalLoopRuntime("startLoopRound defaults loop runtime budget to three rounds", async () => {
  const suffix = `${Date.now()}`;
  const entryAgent = `loop-budget-entry-${suffix}`;
  const peerAgent = `loop-budget-peer-${suffix}`;
  const loopId = `loop-budget-default-${suffix}`;

  const originalGraph = await loadGraph();
  const originalLoopRegistry = await loadGraphLoopRegistry();
  const originalLoopSessionState = await snapshotFile(LOOP_SESSION_STATE_FILE);

  let contractId = null;
  try {
    await Promise.all([
      ensureAgentWorkspace(entryAgent),
      ensureAgentWorkspace(peerAgent),
    ]);
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
    }, null, null, null, logger);
    contractId = startResult?.contractId || null;

    assert.equal(startResult?.action, "started");
    const runtime = await loadActiveLoopRuntime();
    assert.equal(runtime?.budget?.maxRounds, 3);
    assert.equal(runtime?.budget?.usedRounds, 1);
  } finally {
    await saveGraph(originalGraph);
    await saveGraphLoopRegistry(originalLoopRegistry);
    await restoreFile(LOOP_SESSION_STATE_FILE, originalLoopSessionState);
    if (contractId) {
      await rm(getContractPath(contractId), { force: true });
    }
    await rm(agentWorkspace(entryAgent), { recursive: true, force: true });
    await rm(agentWorkspace(peerAgent), { recursive: true, force: true });
  }
});

testWithGlobalLoopRuntime("loop runtime governance concludes before routing beyond maxRounds", async () => {
  const suffix = `${Date.now()}`;
  const entryAgent = `loop-govern-entry-${suffix}`;
  const peerAgent = `loop-govern-peer-${suffix}`;
  const loopId = `loop-governance-${suffix}`;

  const originalGraph = await loadGraph();
  const originalLoopRegistry = await loadGraphLoopRegistry();
  const originalLoopSessionState = await snapshotFile(LOOP_SESSION_STATE_FILE);

  let contractId = null;
  try {
    await Promise.all([
      ensureAgentWorkspace(entryAgent),
      ensureAgentWorkspace(peerAgent),
    ]);
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
    }, null, null, null, logger);
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
    await saveGraph(originalGraph);
    await saveGraphLoopRegistry(originalLoopRegistry);
    await restoreFile(LOOP_SESSION_STATE_FILE, originalLoopSessionState);
    if (contractId) {
      await rm(getContractPath(contractId), { force: true });
    }
    await rm(agentWorkspace(entryAgent), { recursive: true, force: true });
    await rm(agentWorkspace(peerAgent), { recursive: true, force: true });
  }
});
