import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { registerRuntimeAgents } from "../lib/agent/agent-identity.js";
import { runtimeAgentConfigs } from "../lib/state.js";
import { resetRuntimeState } from "../lib/admin/runtime-admin.js";
import {
  clearAllExecutionIncidents,
  listExecutionIncidents,
  upsertExecutionIncident,
} from "../lib/runtime/execution-incident-store.js";
import {
  clearAllPendingSignals,
  hasPendingSignal,
  PENDING_SIGNAL_KINDS,
  registerPendingSignal,
  summarizePendingSignalRegistry,
} from "../lib/runtime/pending-signal-registry.js";
import {
  buildDispatchRuntimeSnapshot,
  enqueueDispatchContract,
  enqueueOutgoingDispatchContract,
  syncDispatchTargets,
} from "../lib/routing/dispatch-runtime-state.js";
import { QUEUE_STATE_FILE } from "../lib/state.js";
import {
  clearProtocolCommitReconcileState,
  getProtocolCommitReconcileStateCounts,
  scheduleProtocolCommitReconcile,
} from "../lib/protocol-commit-reconcile.js";
import {
  rehydrateRuntimeDirectEnvelopePendingSignals,
} from "../lib/runtime-direct-envelope-queue.js";
import { runGlobalTestEnvironmentSerial } from "../lib/formal-runtime/test-locks.js";

const logger = {
  info() {},
  warn() {},
  error() {},
};

test.afterEach(() => {
  clearAllExecutionIncidents();
  clearAllPendingSignals();
  clearProtocolCommitReconcileState();
});

test("runtime reset resyncs managed IDENTITY so a stale planner persona no longer survives into the next run", async () => runGlobalTestEnvironmentSerial(async () => {
  const previousRuntimeConfigs = new Map(runtimeAgentConfigs);
  const workspaceDir = await mkdtemp(join(tmpdir(), "openclaw-runtime-reset-guidance-"));
  const agentId = `planner-reset-${Date.now()}`;
  // ④role lives in IDENTITY.md (managed). A stale managed IDENTITY must be refreshed on resync.
  const stalePlannerIdentity = `<!-- managed-by-watchdog:agent-bootstrap -->
# ${agentId}

## Role

陈旧的规划者身份正文，应在 resync 后被刷新。

- inbox/contract.json 存在 → HEARTBEAT_OK → 停止
`;
  // ⑤SOUL is user-owned; a user-authored SOUL must SURVIVE resync untouched.
  const userSoul = `# ${agentId}\n\n用户自定义人格，平台不应覆盖。\n`;
  const config = {
    agents: {
      list: [
        {
          id: agentId,
          binding: {
            roleRef: "planner",
            workspace: { configured: workspaceDir },
          },
        },
      ],
    },
  };

  try {
    await mkdir(join(workspaceDir, "inbox"), { recursive: true });
    await mkdir(join(workspaceDir, "outbox"), { recursive: true });
    await writeFile(join(workspaceDir, "IDENTITY.md"), stalePlannerIdentity, "utf8");
    await writeFile(join(workspaceDir, "SOUL.md"), userSoul, "utf8");
    await writeFile(join(workspaceDir, "HEARTBEAT.md"), "按 SOUL.md 流程执行。\n", "utf8");

    registerRuntimeAgents(config);

    const result = await resetRuntimeState({
      logger,
      resetSessionAgents: [agentId],
      runtimeApi: { config },
    });

    assert.equal(result.ok, true);

    const identity = await readFile(join(workspaceDir, "IDENTITY.md"), "utf8");
    assert.match(identity, /## Role/);
    assert.doesNotMatch(identity, /陈旧的规划者身份正文/, "stale managed IDENTITY is refreshed");
    assert.doesNotMatch(identity, /inbox\/contract\.json/);
    assert.doesNotMatch(identity, /HEARTBEAT_OK/);

    // user-owned SOUL survives the resync verbatim.
    assert.equal(await readFile(join(workspaceDir, "SOUL.md"), "utf8"), userSoul);
  } finally {
    runtimeAgentConfigs.clear();
    for (const [key, value] of previousRuntimeConfigs.entries()) {
      runtimeAgentConfigs.set(key, value);
    }
    await rm(workspaceDir, { recursive: true, force: true });
  }
}));

test("runtime reset skips normal workspace guidance for hidden control-plane actors", async () => runGlobalTestEnvironmentSerial(async () => {
  const previousRuntimeConfigs = new Map(runtimeAgentConfigs);
  const workspaceDir = await mkdtemp(join(tmpdir(), "openclaw-runtime-reset-operator-guidance-"));
  const agentId = `operator-hidden-${Date.now()}`;
  const config = {
    agents: {
      list: [
        {
          id: agentId,
          role: "agent",
          workspace: workspaceDir,
          plane: "control_plane",
          mainViewVisible: false,
          formalTimelineVisible: false,
          autoWakeEligible: false,
        },
      ],
    },
  };

  try {
    registerRuntimeAgents(config);

    const result = await resetRuntimeState({
      logger,
      resetSessionAgents: [agentId],
      runtimeApi: { config },
    });

    assert.equal(result.ok, true);
    const files = await readdir(workspaceDir);
    assert.equal(files.includes("SOUL.md"), false);
    assert.equal(files.includes("AGENTS.md"), false);
    assert.equal(files.includes("agent-card.json"), false);
  } finally {
    runtimeAgentConfigs.clear();
    for (const [key, value] of previousRuntimeConfigs.entries()) {
      runtimeAgentConfigs.set(key, value);
    }
    await rm(workspaceDir, { recursive: true, force: true });
  }
}));

test("runtime reset clears execution incidents so operator/runtime truth does not leak across runs", async () => runGlobalTestEnvironmentSerial(async () => {
  upsertExecutionIncident({
    contractId: "TC-reset-1",
    epochKey: "agent:worker:main:run-reset",
    sessionKey: "agent:worker:main",
    agentId: "worker",
    rootFault: "llm_fault",
    firstFaultCode: "identical_tool_loop",
    status: "fail_fast",
  });

  assert.equal(listExecutionIncidents().length, 1);

  const result = await resetRuntimeState({
    logger,
    resetSessionAgents: [],
    runtimeApi: null,
  });

  assert.equal(result.ok, true);
  assert.equal(listExecutionIncidents().length, 0);
}));

test("runtime reset reports cleared dispatch queue as a resolved count", async () => runGlobalTestEnvironmentSerial(async () => {
  await syncDispatchTargets(["worker-reset-queue"], logger);
  enqueueDispatchContract("worker-reset-queue", "TC-reset-queued-1", {}, logger);
  enqueueOutgoingDispatchContract("worker-reset-queue", "TC-reset-queued-2", {
    targetAgent: "worker-reset-target",
  }, logger);

  assert.equal(buildDispatchRuntimeSnapshot().contractFlow.incomingQueued, 1);
  assert.equal(buildDispatchRuntimeSnapshot().contractFlow.outgoingQueued, 1);

  const result = await resetRuntimeState({
    logger,
    resetSessionAgents: [],
    runtimeApi: null,
  });

  assert.equal(result.ok, true);
  assert.equal(typeof result.cleared.queue, "number");
  assert.equal(result.cleared.queue, 2);
  assert.equal(buildDispatchRuntimeSnapshot().contractFlow.incomingQueued, 0);
  assert.equal(buildDispatchRuntimeSnapshot().contractFlow.outgoingQueued, 0);
}));

test("runtime reset clears pending signals that would otherwise keep agents actionable", async () => runGlobalTestEnvironmentSerial(async () => {
  const previousRuntimeConfigs = new Map(runtimeAgentConfigs);
  const agentId = "worker-reset-pending-signal";

  try {
    registerRuntimeAgents({
      agents: {
        list: [
          {
            id: agentId,
            role: "executor",
            autoWakeEligible: true,
          },
        ],
      },
    });
    registerPendingSignal({
      agentId,
      sourceKind: PENDING_SIGNAL_KINDS.RUNTIME_DIRECT_ENVELOPE,
      sourceRef: "direct-reset-test",
    });

    assert.equal(hasPendingSignal(agentId), true);

    const result = await resetRuntimeState({
      logger,
      resetSessionAgents: [],
      runtimeApi: null,
    });

    assert.equal(result.ok, true);
    assert.equal(hasPendingSignal(agentId), false);
    assert.equal(summarizePendingSignalRegistry().activeSignals, 0);
  } finally {
    runtimeAgentConfigs.clear();
    for (const [key, value] of previousRuntimeConfigs.entries()) {
      runtimeAgentConfigs.set(key, value);
    }
  }
}));

test("runtime reset clears protocol commit reconcile timers", async () => runGlobalTestEnvironmentSerial(async () => {
  scheduleProtocolCommitReconcile({
    sessionKey: "agent:worker-reset-protocol:contract:TC-RESET-PROTOCOL",
    agentId: "worker-reset-protocol",
    commitInfo: {
      type: "runtime_result",
      fileName: "runtime_result.json",
      commitPath: join(tmpdir(), `runtime-reset-protocol-${Date.now()}.json`),
      allowMissing: true,
    },
    logger,
  });

  assert.equal(getProtocolCommitReconcileStateCounts().pendingReconcileTimers, 1);

  const result = await resetRuntimeState({
    logger,
    resetSessionAgents: [],
    runtimeApi: null,
  });

  assert.equal(result.ok, true);
  assert.equal(getProtocolCommitReconcileStateCounts().pendingReconcileTimers, 0);
  assert.equal(getProtocolCommitReconcileStateCounts().pendingDeferredReleases, 0);
}));

test("runtime reset clears persisted runtime direct-envelope queues for configured agents", async () => runGlobalTestEnvironmentSerial(async () => {
  const previousRuntimeConfigs = new Map(runtimeAgentConfigs);
  const agentId = `worker-reset-direct-envelope-${Date.now()}`;
  const workspaceDir = await mkdtemp(join(tmpdir(), "openclaw-runtime-reset-direct-envelope-"));
  const inboxDir = join(workspaceDir, "inbox");
  const queueDir = join(inboxDir, ".runtime-direct-envelope-queue");

  try {
    runtimeAgentConfigs.clear();
    runtimeAgentConfigs.set(agentId, {
      id: agentId,
      role: "executor",
      workspace: workspaceDir,
      mainViewVisible: true,
      autoWakeEligible: true,
    });
    await mkdir(queueDir, { recursive: true });
    await writeFile(join(inboxDir, "contract.json"), JSON.stringify({
      protocol: { envelope: "direct_request" },
      id: "DIRECT-ACTIVE-RESET",
    }), "utf8");
    await writeFile(
      join(queueDir, `contract-${Date.now()}-000000-DIRECT-QUEUED-RESET.json`),
      JSON.stringify({
        protocol: { envelope: "direct_request" },
        id: "DIRECT-QUEUED-RESET",
      }),
      "utf8",
    );

    const result = await resetRuntimeState({
      logger,
      resetSessionAgents: [agentId],
      runtimeApi: null,
    });
    const rehydrated = await rehydrateRuntimeDirectEnvelopePendingSignals({ logger });

    assert.equal(result.ok, true);
    assert.equal(result.cleared.runtimeDirectEnvelopeFiles, 2);
    assert.equal(rehydrated.registered, 0);
    assert.equal(hasPendingSignal(agentId), false);
    await assert.rejects(readFile(join(inboxDir, "contract.json"), "utf8"), /ENOENT/);
    await assert.rejects(readdir(queueDir), /ENOENT/);
  } finally {
    clearAllPendingSignals();
    runtimeAgentConfigs.clear();
    for (const [key, value] of previousRuntimeConfigs.entries()) {
      runtimeAgentConfigs.set(key, value);
    }
    await rm(workspaceDir, { recursive: true, force: true });
  }
}));

test("runtime reset persists dispatch queue state through the canonical queue schema", async () => runGlobalTestEnvironmentSerial(async () => {
  await syncDispatchTargets(["worker-reset-schema"], logger);
  enqueueDispatchContract("worker-reset-schema", "TC-reset-schema-in", {}, logger);
  enqueueOutgoingDispatchContract("worker-reset-schema", "TC-reset-schema-out", {
    targetAgent: "worker-reset-target",
  }, logger);

  const result = await resetRuntimeState({
    logger,
    resetSessionAgents: [],
    runtimeApi: null,
  });
  const persisted = JSON.parse(await readFile(QUEUE_STATE_FILE, "utf8"));

  assert.equal(result.ok, true);
  assert.equal(persisted && typeof persisted, "object");
  assert.equal(persisted.targets && typeof persisted.targets, "object");
  assert.equal(persisted.outgoing && typeof persisted.outgoing, "object");
  assert.equal(Number.isFinite(persisted.savedAt), true);
  assert.deepEqual(persisted.outgoing, {});
}));
