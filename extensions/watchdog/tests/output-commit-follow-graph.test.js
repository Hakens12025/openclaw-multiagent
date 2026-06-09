import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, readdir, rm, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { loadGraph } from "../lib/agent/agent-graph.js";
import { saveGraph } from "../lib/agent/agent-graph-mutations.js";
import { executeAdminSurfaceOperation } from "../lib/admin/admin-surface-operations.js";
import { getContractPath, persistContractSnapshot } from "../lib/contracts.js";
import { CONTRACT_STATUS } from "../lib/core/runtime-status.js";
import { runAgentEndLifecycle } from "../lib/lifecycle/agent-end-lifecycle.js";
import {
  loadGraphLoopRegistry,
  saveGraphLoopRegistry,
} from "../lib/loop/graph-loop-registry.js";
import { loadActiveLoopRuntime } from "../lib/loop/loop-round-runtime.js";
import { LOOP_SESSION_STATE_FILE } from "../lib/loop/loop-session-store.js";
import { createTrackingState } from "../lib/session-bootstrap.js";
import { agentWorkspace, cfg } from "../lib/state.js";
import { clearTrackingStore } from "../lib/store/tracker-store.js";
import { notifyTrackingContractClaim } from "../lib/store/tracker-store.js";
import { runGlobalTestEnvironmentSerial } from "../lib/formal-runtime/test-locks.js";

// Loop members for this regression: core agents that always exist in the registry.
// (composeGraphLoop validates ids against the live registry, so the test must not
// hard-code experimental agents that may be removed — see worker-3/4 drift, 备忘录.)
const ENTRY_AGENT = "planner";
const NEXT_AGENT = "worker";

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

function extractContractIdFromSessionKey(sessionKey) {
  const match = typeof sessionKey === "string"
    ? sessionKey.match(/^agent:[^:]+:contract:(.+)$/i)
    : null;
  return match?.[1] || null;
}

test("output_commit on loop shared contract stays observational and must not advance graph", async () => runGlobalTestEnvironmentSerial(async () => {
  const loopId = `test-output-commit-follow-graph-${Date.now()}`;
  const heartbeatCalls = [];
  const originalGraph = await loadGraph();
  const originalLoopRegistry = await loadGraphLoopRegistry();
  const originalLoopSessionState = await snapshotFile(LOOP_SESSION_STATE_FILE);
  const originalHooksToken = cfg.hooksToken;
  const entryInboxFile = join(agentWorkspace(ENTRY_AGENT), "inbox", "contract.json");
  const nextInboxFile = join(agentWorkspace(NEXT_AGENT), "inbox", "contract.json");

  try {
    clearTrackingStore();
    cfg.hooksToken = "";
    await cleanAgentBoxes(ENTRY_AGENT);
    await cleanAgentBoxes(NEXT_AGENT);
    await rm(LOOP_SESSION_STATE_FILE, { force: true });
    await saveGraph({ edges: [] });
    await saveGraphLoopRegistry({ loops: [] });

    const composed = await executeAdminSurfaceOperation({
      surfaceId: "graph.loop.compose",
      payload: {
        loopId,
        label: "direct output follow_graph regression",
        agents: [ENTRY_AGENT, NEXT_AGENT],
      },
      logger,
      runtimeContext: null,
    });
    assert.equal(composed?.loop?.active, true);

    const startResult = await executeAdminSurfaceOperation({
      surfaceId: "runtime.loop.start",
      payload: {
        loopId,
        requestedTask: `${ENTRY_AGENT} 完成后应自动推进到 ${NEXT_AGENT}`,
        startAgent: ENTRY_AGENT,
      },
      logger,
      runtimeContext: {
        api: {
          runtime: {
            system: {
              requestHeartbeatNow(payload) {
                heartbeatCalls.push(payload);
                const contractId = extractContractIdFromSessionKey(payload?.sessionKey);
                if (contractId && payload?.sessionKey) {
                  setTimeout(() => {
                    notifyTrackingContractClaim(payload.sessionKey, contractId);
                  }, 0);
                }
              },
            },
          },
        },
        originSurfaceId: "runtime.loop.start",
        originDraftId: null,
        originExecutionId: null,
      },
    });
    assert.equal(startResult?.action, "started");
    assert.equal(startResult?.targetAgent, ENTRY_AGENT);

    const entryInboxContract = await readJsonFile(entryInboxFile);
    const contractPath = getContractPath(entryInboxContract.id);
    await persistContractSnapshot(contractPath, {
      ...(await readJsonFile(contractPath)),
      status: CONTRACT_STATUS.RUNNING,
      updatedAt: Date.now(),
    }, logger);

    // outbox 统一(f7769b5): agent 把交付物写进 outbox/，不再写中央 contract.output。
    const entryOutboxDir = join(agentWorkspace(ENTRY_AGENT), "outbox");
    await mkdir(entryOutboxDir, { recursive: true });
    await writeFile(
      join(entryOutboxDir, "runtime_result.json"),
      JSON.stringify({
        output: `# ${ENTRY_AGENT} output\n\n本阶段完成，等待 runtime 依据唯一 loop 出边推进到 ${NEXT_AGENT}。\n`,
      }),
      "utf8",
    );

    const trackingState = createTrackingState({
      sessionKey: `synthetic:${ENTRY_AGENT}:${entryInboxContract.id}`,
      agentId: ENTRY_AGENT,
      parentSession: null,
    });
    trackingState.contract = {
      ...entryInboxContract,
      path: contractPath,
      status: CONTRACT_STATUS.RUNNING,
    };

    await runAgentEndLifecycle({
      event: {
        success: true,
        synthetic: true,
        protocolBoundary: "canonical_outbox_commit",
        commitType: "output_commit",
      },
      ctx: {
        sessionKey: trackingState.sessionKey,
        agentId: ENTRY_AGENT,
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
      trackingState,
    });

    const persistedContract = await readJsonFile(contractPath);
    const loopRuntimeSnapshot = await loadActiveLoopRuntime();
    const loopSessionState = await readJsonFile(LOOP_SESSION_STATE_FILE);

    assert.notEqual(persistedContract.status, CONTRACT_STATUS.COMPLETED);
    assert.equal(persistedContract.id, entryInboxContract.id);
    assert.equal(persistedContract.assignee, ENTRY_AGENT);
    assert.equal(loopRuntimeSnapshot?.loopId, loopId);
    assert.equal(loopRuntimeSnapshot?.currentStage, ENTRY_AGENT);
    assert.equal(loopSessionState?.activeSession?.currentStage, ENTRY_AGENT);
    await assert.rejects(
      readFile(nextInboxFile, "utf8"),
      { code: "ENOENT" },
      "output_commit must not dispatch the contract to the next loop member",
    );
    assert.equal(
      heartbeatCalls.some((entry) => entry?.agentId === NEXT_AGENT),
      false,
      "output_commit must not wake the next loop member",
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
    await rm(entryInboxFile, { force: true }).catch(() => {});
    await rm(nextInboxFile, { force: true }).catch(() => {});
  }
}));
