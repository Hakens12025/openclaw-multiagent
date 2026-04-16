import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";

import { loadGraph, saveGraph } from "../lib/agent/agent-graph.js";
import { startRuntimeLoop } from "../lib/admin/admin-surface-loop-operations.js";
import {
  composeLoopSpecFromAgents,
  loadGraphLoopRegistry,
  saveGraphLoopRegistry,
} from "../lib/loop/graph-loop-registry.js";
import {
  clearLoopSessionState,
  LOOP_SESSION_STATE_FILE,
  loadLoopSessionState,
} from "../lib/loop/loop-session-store.js";
import { agentWorkspace } from "../lib/state.js";
import { runGlobalTestEnvironmentSerial } from "./test-locks.js";

const logger = {
  info() {},
  warn() {},
  error() {},
};

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

async function ensureAgentWorkspace(agentId) {
  await mkdir(agentWorkspace(agentId), { recursive: true });
  await mkdir(`${agentWorkspace(agentId)}/inbox`, { recursive: true });
}

testWithGlobalLoopRuntime("runtime.loop.start preserves loop entry truth and actual start member truth", async () => {
  const suffix = `${Date.now()}`;
  const entryAgent = `loop-entry-${suffix}`;
  const middleAgent = `loop-middle-${suffix}`;
  const endAgent = `loop-end-${suffix}`;
  const loopId = `loop-start-member-${suffix}`;

  const originalGraph = await loadGraph();
  const originalLoopRegistry = await loadGraphLoopRegistry();
  const originalLoopSessionState = await snapshotFile(LOOP_SESSION_STATE_FILE);

  try {
    await Promise.all([
      ensureAgentWorkspace(entryAgent),
      ensureAgentWorkspace(middleAgent),
      ensureAgentWorkspace(endAgent),
    ]);

    await saveGraph({
      edges: [
        { from: entryAgent, to: middleAgent, label: "loop" },
        { from: middleAgent, to: endAgent, label: "loop" },
        { from: endAgent, to: entryAgent, label: "loop" },
      ],
    });
    await saveGraphLoopRegistry({
      loops: [
        composeLoopSpecFromAgents([entryAgent, middleAgent, endAgent], {
          id: loopId,
          entryAgentId: entryAgent,
        }),
      ],
    });
    await clearLoopSessionState();

    const result = await startRuntimeLoop({
      payload: {
        loopId,
        startAgent: middleAgent,
        requestedTask: "验证 loop 随机起步真值",
        requestedSource: "test.runtime.loop.start.member-truth",
      },
      logger,
      runtimeContext: {
        api: {
          runtime: {
            system: {
              requestHeartbeatNow() {},
            },
          },
        },
        enqueue() { return true; },
      },
    });

    const sessionState = await loadLoopSessionState();
    const activeSession = sessionState?.activeSession || null;

    assert.equal(result.ok, true);
    assert.equal(result.resolvedLoopId, loopId);
    assert.equal(result.resolvedEntryAgent, entryAgent);
    assert.equal(result.resolvedStartAgent, middleAgent);
    assert.equal(result.currentStage, middleAgent);
    assert.equal(result.targetAgent, middleAgent);

    assert.equal(activeSession?.loopId, loopId);
    assert.equal(activeSession?.entryAgentId, entryAgent);
    assert.equal(activeSession?.startAgentId, middleAgent);
    assert.equal(activeSession?.currentStage, middleAgent);
  } finally {
    await saveGraph(originalGraph);
    await saveGraphLoopRegistry(originalLoopRegistry);
    await restoreFile(LOOP_SESSION_STATE_FILE, originalLoopSessionState);
  }
});
