import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";

import { loadGraph } from "../lib/agent/agent-graph.js";
import { saveGraph } from "../lib/agent/agent-graph-mutations.js";
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
import { cfg, dispatchOutgoingStateMap, dispatchTargetStateMap, runtimeAgentConfigs } from "../lib/state.js";
import { agentWorkspace } from "../lib/state.js";
import { clearTrackingStore, listTrackingEntries, notifyTrackingContractClaim, rememberTrackingState } from "../lib/store/tracker-store.js";
import { runGlobalTestEnvironmentSerial } from "../lib/formal-runtime/test-locks.js";

const logger = {
  info() {},
  warn() {},
  error() {},
};

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

function extractContractIdFromSessionKey(sessionKey) {
  const match = typeof sessionKey === "string"
    ? sessionKey.match(/^agent:[^:]+:contract:(.+)$/i)
    : null;
  return match?.[1] || null;
}

async function ensureAgentWorkspace(agentId) {
  await mkdir(agentWorkspace(agentId), { recursive: true });
  await mkdir(`${agentWorkspace(agentId)}/inbox`, { recursive: true });
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

testWithGlobalLoopRuntime("runtime.loop.start preserves loop entry truth and actual start member truth", async () => {
  const suffix = uniqueSuffix();
  const entryAgent = `loop-entry-${suffix}`;
  const middleAgent = `loop-middle-${suffix}`;
  const endAgent = `loop-end-${suffix}`;
  const loopId = `loop-start-member-${suffix}`;

  const originalGraph = await loadGraph();
  const originalLoopRegistry = await loadGraphLoopRegistry();
  const originalLoopSessionState = await snapshotFile(LOOP_SESSION_STATE_FILE);
  const originalHooksToken = cfg.hooksToken;
  const originalRuntimeAgentConfigs = new Map(runtimeAgentConfigs);
  const originalRuntimeMutableState = snapshotRuntimeMutableState();

  try {
    cfg.hooksToken = "";
    await Promise.all([
      ensureAgentWorkspace(entryAgent),
      ensureAgentWorkspace(middleAgent),
      ensureAgentWorkspace(endAgent),
    ]);
    registerLoopRuntimeAgents([entryAgent, middleAgent, endAgent]);

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
              requestHeartbeatNow({ sessionKey } = {}) {
                const contractId = extractContractIdFromSessionKey(sessionKey);
                if (contractId) {
                  setTimeout(() => {
                    notifyTrackingContractClaim(sessionKey, contractId);
                  }, 0);
                }
              },
            },
          },
        },
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
    cfg.hooksToken = originalHooksToken;
    restoreRuntimeAgentConfigs(originalRuntimeAgentConfigs);
    restoreRuntimeMutableState(originalRuntimeMutableState);
    await saveGraph(originalGraph);
    await saveGraphLoopRegistry(originalLoopRegistry);
    await restoreFile(LOOP_SESSION_STATE_FILE, originalLoopSessionState);
  }
});

testWithGlobalLoopRuntime("runtime.loop.start forwards explicit loop budget into active loop session", async () => {
  const suffix = uniqueSuffix();
  const entryAgent = `loop-budget-entry-${suffix}`;
  const middleAgent = `loop-budget-middle-${suffix}`;
  const endAgent = `loop-budget-end-${suffix}`;
  const loopId = `loop-start-budget-${suffix}`;

  const originalGraph = await loadGraph();
  const originalLoopRegistry = await loadGraphLoopRegistry();
  const originalLoopSessionState = await snapshotFile(LOOP_SESSION_STATE_FILE);
  const originalHooksToken = cfg.hooksToken;
  const originalRuntimeAgentConfigs = new Map(runtimeAgentConfigs);
  const originalRuntimeMutableState = snapshotRuntimeMutableState();

  try {
    cfg.hooksToken = "";
    await Promise.all([
      ensureAgentWorkspace(entryAgent),
      ensureAgentWorkspace(middleAgent),
      ensureAgentWorkspace(endAgent),
    ]);
    registerLoopRuntimeAgents([entryAgent, middleAgent, endAgent]);

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
        requestedTask: "验证 runtime.loop.start 预算下发",
        requestedSource: "test.runtime.loop.start.budget",
        budget: {
          maxRounds: 1,
          maxExperiments: 4,
        },
      },
      logger,
      runtimeContext: {
        api: {
          runtime: {
            system: {
              requestHeartbeatNow({ sessionKey } = {}) {
                const contractId = extractContractIdFromSessionKey(sessionKey);
                if (contractId) {
                  setTimeout(() => {
                    notifyTrackingContractClaim(sessionKey, contractId);
                  }, 0);
                }
              },
            },
          },
        },
      },
    });

    const sessionState = await loadLoopSessionState();
    const activeSession = sessionState?.activeSession || null;

    assert.equal(result.ok, true);
    assert.equal(activeSession?.budget?.maxRounds, 1);
    assert.equal(activeSession?.budget?.maxExperiments, 4);
  } finally {
    cfg.hooksToken = originalHooksToken;
    restoreRuntimeAgentConfigs(originalRuntimeAgentConfigs);
    restoreRuntimeMutableState(originalRuntimeMutableState);
    await saveGraph(originalGraph);
    await saveGraphLoopRegistry(originalLoopRegistry);
    await restoreFile(LOOP_SESSION_STATE_FILE, originalLoopSessionState);
  }
});
