import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, readdir, rm, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { loadGraph, saveGraph } from "../lib/agent/agent-graph.js";
import { executeAdminSurfaceOperation } from "../lib/admin/admin-surface-operations.js";
import { getContractPath, persistContractSnapshot } from "../lib/contracts.js";
import { CONTRACT_STATUS } from "../lib/core/runtime-status.js";
import { runAgentEndPipeline } from "../lib/lifecycle/agent-end-pipeline.js";
import {
  loadGraphLoopRegistry,
  saveGraphLoopRegistry,
} from "../lib/loop/graph-loop-registry.js";
import { loadActiveLoopRuntime } from "../lib/loop/loop-round-runtime.js";
import { LOOP_SESSION_STATE_FILE } from "../lib/loop/loop-session-store.js";
import { createTrackingState } from "../lib/session-bootstrap.js";
import { agentWorkspace, cfg } from "../lib/state.js";
import { clearTrackingStore } from "../lib/store/tracker-store.js";
import { runGlobalTestEnvironmentSerial } from "./test-locks.js";

const logger = {
  info() {},
  warn() {},
  error() {},
};

async function readJsonFile(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function snapshotFile(filePath) {
  return readFile(filePath, "utf8").catch(() => null);
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

test("output_commit on loop shared contract follows graph without pipeline runtime state or child stage contracts", async () => runGlobalTestEnvironmentSerial(async () => {
  const loopId = `test-output-commit-follow-graph-${Date.now()}`;
  const heartbeatCalls = [];
  const originalGraph = await loadGraph();
  const originalLoopRegistry = await loadGraphLoopRegistry();
  const originalLoopSessionState = await snapshotFile(LOOP_SESSION_STATE_FILE);
  const originalHooksToken = cfg.hooksToken;
  const worker3InboxFile = join(agentWorkspace("worker-3"), "inbox", "contract.json");
  const worker4InboxFile = join(agentWorkspace("worker-4"), "inbox", "contract.json");

  try {
    clearTrackingStore();
    cfg.hooksToken = "";
    await cleanAgentBoxes("worker-3");
    await cleanAgentBoxes("worker-4");
    await rm(LOOP_SESSION_STATE_FILE, { force: true });
    await saveGraph({ edges: [] });
    await saveGraphLoopRegistry({ loops: [] });

    const composed = await executeAdminSurfaceOperation({
      surfaceId: "graph.loop.compose",
      payload: {
        loopId,
        label: "direct output follow_graph regression",
        agents: ["worker-3", "worker-4"],
      },
      logger,
      runtimeContext: null,
    });
    assert.equal(composed?.loop?.active, true);

    const startResult = await executeAdminSurfaceOperation({
      surfaceId: "runtime.loop.start",
      payload: {
        loopId,
        requestedTask: "worker-3 完成后应自动推进到 worker-4",
        startAgent: "worker-3",
      },
      logger,
      runtimeContext: {
        api: {
          runtime: {
            system: {
              requestHeartbeatNow(payload) {
                heartbeatCalls.push(payload);
              },
            },
          },
        },
        enqueue: () => {},
        originSurfaceId: "runtime.loop.start",
        originDraftId: null,
        originExecutionId: null,
      },
    });
    assert.equal(startResult?.action, "started");
    assert.equal(startResult?.targetAgent, "worker-3");

    const worker3InboxContract = await readJsonFile(worker3InboxFile);
    const contractPath = getContractPath(worker3InboxContract.id);
    await persistContractSnapshot(contractPath, {
      ...(await readJsonFile(contractPath)),
      status: CONTRACT_STATUS.RUNNING,
      updatedAt: Date.now(),
    }, logger);

    await writeFile(
      worker3InboxContract.output,
      "# worker-3 output\n\n本阶段完成，等待 runtime 依据唯一 loop 出边推进到 worker-4。\n",
      "utf8",
    );

    const trackingState = createTrackingState({
      sessionKey: `synthetic:worker-3:${worker3InboxContract.id}`,
      agentId: "worker-3",
      parentSession: null,
    });
    trackingState.contract = {
      ...worker3InboxContract,
      path: contractPath,
      status: CONTRACT_STATUS.RUNNING,
    };

    await runAgentEndPipeline({
      event: {
        success: true,
        synthetic: true,
        protocolBoundary: "canonical_outbox_commit",
        commitType: "output_commit",
      },
      ctx: {
        sessionKey: trackingState.sessionKey,
        agentId: "worker-3",
      },
      api: {
        runtime: {
          system: {
            requestHeartbeatNow(payload) {
              heartbeatCalls.push(payload);
            },
          },
        },
      },
      logger,
      enqueueFn: () => {},
      wakePlanner: async () => null,
      trackingState,
    });

    const persistedContract = await readJsonFile(contractPath);
    const loopRuntimeSnapshot = await loadActiveLoopRuntime();
    const loopSessionState = await readJsonFile(LOOP_SESSION_STATE_FILE);
    const worker4InboxContract = await readJsonFile(worker4InboxFile);

    assert.notEqual(persistedContract.status, CONTRACT_STATUS.COMPLETED);
    assert.equal(persistedContract.id, worker3InboxContract.id);
    assert.equal(worker4InboxContract?.id, worker3InboxContract.id);
    assert.equal(worker4InboxContract?.assignee, "worker-4");
    assert.equal(persistedContract.executionObservation?.stageRunResult?.completion?.transition?.kind, "follow_graph");
    assert.equal(loopRuntimeSnapshot?.loopId, loopId);
    assert.equal(loopRuntimeSnapshot?.currentStage, "worker-4");
    assert.equal(loopSessionState?.activeSession?.currentStage, "worker-4");
    assert.ok(
      heartbeatCalls.some((entry) => entry?.agentId === "worker-4"),
      "expected runtime to heartbeat worker-4 after advancing",
    );
  } finally {
    clearTrackingStore();
    cfg.hooksToken = originalHooksToken;
    await saveGraph(originalGraph);
    await saveGraphLoopRegistry(originalLoopRegistry);
    if (typeof originalLoopSessionState === "string") {
      await writeFile(LOOP_SESSION_STATE_FILE, originalLoopSessionState, "utf8");
    } else {
      await rm(LOOP_SESSION_STATE_FILE, { force: true });
    }
    await rm(worker3InboxFile, { force: true }).catch(() => {});
    await rm(worker4InboxFile, { force: true }).catch(() => {});
  }
}));
