import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { OC, agentWorkspace } from "../lib/state.js";
import {
  createAgentDefinition,
  deleteAgentDefinition,
  hardDeleteAgentDefinition,
} from "../lib/agent/agent-admin-agent-operations.js";
import { saveConfig } from "../lib/agent/agent-admin-store.js";
import { loadGraph, saveGraph } from "../lib/agent/agent-graph.js";
import { listDispatchTargetIds } from "../lib/routing/dispatch-runtime-state.js";
import {
  loadGraphLoopRegistry,
  saveGraphLoopRegistry,
} from "../lib/loop/graph-loop-registry.js";
import {
  LOOP_SESSION_STATE_FILE,
  loadLoopSessionState,
} from "../lib/loop/loop-session-store.js";
import { summarizeLocalAgentDiscovery } from "../lib/agent/agent-enrollment-discovery.js";
import {
  buildAgentCard,
  syncAgentWorkspaceGuidance,
} from "../lib/workspace-guidance-writer.js";
import { runGlobalTestEnvironmentSerial } from "./test-locks.js";

const logger = {
  info() {},
  warn() {},
  error() {},
};

let deleteScenarioQueue = Promise.resolve();

function runDeleteScenarioSerial(task) {
  const next = deleteScenarioQueue.then(task, task);
  deleteScenarioQueue = next.catch(() => {});
  return next;
}

async function withDeleteScenario(prefix, runAssertions) {
  return runGlobalTestEnvironmentSerial(() => runDeleteScenarioSerial(async () => {
    const tempAgentId = `${prefix}-${Date.now()}`;
    const workspaceDir = agentWorkspace(tempAgentId);
    const sentinelFile = join(workspaceDir, "output", "sentinel.txt");
    const originalConfigRaw = await readFile(join(OC, "openclaw.json"), "utf8");
    const originalGraph = await loadGraph();
    const originalLoopRegistry = await loadGraphLoopRegistry();
    const originalLoopSessionRaw = await readFile(LOOP_SESSION_STATE_FILE, "utf8").catch(() => null);

    try {
      await createAgentDefinition({
        id: tempAgentId,
        role: "executor",
        model: "ark-anthropic/deepseek-v3.2",
        logger,
      });
      await mkdir(join(workspaceDir, "output"), { recursive: true });
      await writeFile(sentinelFile, "sentinel", "utf8");

      await saveGraph({
        edges: [
          { from: "controller", to: "planner", label: "ingress" },
          { from: "planner", to: tempAgentId, label: "assign" },
          { from: tempAgentId, to: "worker", label: "handoff" },
        ],
      });

      await saveGraphLoopRegistry({
        loops: [
          {
            id: "loop-valid-delete-cleanup",
            nodes: ["planner", "worker"],
            entryAgentId: "planner",
          },
          {
            id: "loop-stale-delete-cleanup",
            nodes: [tempAgentId, "worker"],
            entryAgentId: tempAgentId,
          },
        ],
      });

      await mkdir(join(OC, "research-lab"), { recursive: true });
      await writeFile(LOOP_SESSION_STATE_FILE, JSON.stringify({
        activeSession: {
          id: "LS-stale-delete-cleanup",
          loopId: "loop-stale-delete-cleanup",
          entryAgentId: tempAgentId,
          currentStage: tempAgentId,
          status: "active",
          nodes: [tempAgentId, "worker"],
          startedAt: Date.now(),
          updatedAt: Date.now(),
        },
        recentSessions: [
          {
            id: "LS-valid-delete-cleanup",
            loopId: "loop-valid-delete-cleanup",
            entryAgentId: "planner",
            currentStage: "planner",
            status: "concluded",
            nodes: ["planner", "worker"],
            startedAt: Date.now(),
            updatedAt: Date.now(),
          },
        ],
      }, null, 2), "utf8");

      await runAssertions({
        tempAgentId,
        workspaceDir,
        sentinelFile,
      });
    } finally {
      await saveConfig(JSON.parse(originalConfigRaw));
      await saveGraph(originalGraph);
      await saveGraphLoopRegistry(originalLoopRegistry);
      if (originalLoopSessionRaw == null) {
        await rm(LOOP_SESSION_STATE_FILE, { force: true });
      } else {
        await writeFile(LOOP_SESSION_STATE_FILE, originalLoopSessionRaw, "utf8");
      }
      await rm(workspaceDir, { recursive: true, force: true });
    }
  }));
}

test("deleteAgentDefinition prunes graph, loop registry, and loop sessions for deleted agents while keeping workspace files", { concurrency: false }, async () => {
  await withDeleteScenario("delete-cleanup", async ({
    tempAgentId,
    sentinelFile,
  }) => {
    const result = await deleteAgentDefinition({
      agentId: tempAgentId,
      logger,
    });

    assert.equal(result.ok, true);

    const graph = await loadGraph();
    assert.equal(
      graph.edges.some((edge) => edge.from === tempAgentId || edge.to === tempAgentId),
      false,
      "deleted agent edges should be pruned from live graph",
    );
    assert.equal(
      graph.edges.some((edge) => edge.from === "controller" && edge.to === "planner"),
      true,
      "unrelated graph edges should remain",
    );

    const registry = await loadGraphLoopRegistry();
    assert.deepEqual(
      registry.loops.map((entry) => entry.id),
      ["loop-valid-delete-cleanup"],
    );

    const sessionState = await loadLoopSessionState();
    assert.equal(sessionState.activeSession, null);
    assert.deepEqual(
      sessionState.recentSessions.map((entry) => entry.id),
      ["LS-valid-delete-cleanup"],
    );

    const sentinel = await readFile(sentinelFile, "utf8");
    assert.equal(sentinel, "sentinel");
  });
});

test("agent admin create/delete keeps dispatch runtime targets aligned with the live agent roster", { concurrency: false }, async () => {
  await withDeleteScenario("dispatch-target-sync", async ({
    tempAgentId,
  }) => {
    assert.equal(
      listDispatchTargetIds().includes(tempAgentId),
      true,
      "newly created executor should become a dispatch target without requiring a restart",
    );

    const result = await deleteAgentDefinition({
      agentId: tempAgentId,
      logger,
    });

    assert.equal(result.ok, true);
    assert.equal(
      listDispatchTargetIds().includes(tempAgentId),
      false,
      "deleted idle executor should be pruned from dispatch targets immediately",
    );
  });
});

test("hardDeleteAgentDefinition removes workspace files from disk while pruning topology residues", { concurrency: false }, async () => {
  await withDeleteScenario("hard-delete-cleanup", async ({
    tempAgentId,
    workspaceDir,
  }) => {
    const result = await hardDeleteAgentDefinition({
      agentId: tempAgentId,
      logger,
    });

    assert.equal(result.ok, true);

    const graph = await loadGraph();
    assert.equal(
      graph.edges.some((edge) => edge.from === tempAgentId || edge.to === tempAgentId),
      false,
      "hard-deleted agent edges should be pruned from live graph",
    );

    const registry = await loadGraphLoopRegistry();
    assert.deepEqual(
      registry.loops.map((entry) => entry.id),
      ["loop-valid-delete-cleanup"],
    );

    const sessionState = await loadLoopSessionState();
    assert.equal(sessionState.activeSession, null);
    assert.deepEqual(
      sessionState.recentSessions.map((entry) => entry.id),
      ["LS-valid-delete-cleanup"],
    );

    await assert.rejects(() => readFile(join(workspaceDir, "output", "sentinel.txt"), "utf8"));
  });
});

test("hardDeleteAgentDefinition removes unregistered local workspace residue via discovered workspace path", { concurrency: false }, async () => {
  await runGlobalTestEnvironmentSerial(() => runDeleteScenarioSerial(async () => {
    const dirName = `residue-hard-delete-${Date.now()}`;
    const residueAgentId = `Residue-Hard-Delete-${Date.now()}`;
    const workspaceDir = join(OC, "workspaces", dirName);
    const sentinelFile = join(workspaceDir, "output", "sentinel.txt");
    const originalConfigRaw = await readFile(join(OC, "openclaw.json"), "utf8");
    const originalGraph = await loadGraph();
    const originalLoopRegistry = await loadGraphLoopRegistry();
    const originalLoopSessionRaw = await readFile(LOOP_SESSION_STATE_FILE, "utf8").catch(() => null);

    try {
      await mkdir(workspaceDir, { recursive: true });
      await syncAgentWorkspaceGuidance({
        agentId: residueAgentId,
        role: "executor",
        skills: [],
        workspaceDir,
        graph: { edges: [] },
        loops: [],
      });
      await writeFile(
        join(workspaceDir, "agent-card.json"),
        JSON.stringify(buildAgentCard({ agentId: residueAgentId, role: "executor", skills: [] }), null, 2),
        "utf8",
      );
      await mkdir(join(workspaceDir, "output"), { recursive: true });
      await writeFile(sentinelFile, "sentinel", "utf8");

      const beforeDiscovery = await summarizeLocalAgentDiscovery({ includeLocalWorkspace: true });
      assert.equal(
        beforeDiscovery.localWorkspaceResidue.some((entry) => entry.id === residueAgentId),
        true,
      );

      await saveGraph({
        edges: [
          { from: "planner", to: residueAgentId, label: "assign" },
          { from: residueAgentId, to: "worker", label: "handoff" },
          { from: "controller", to: "planner", label: "ingress" },
        ],
      });

      await saveGraphLoopRegistry({
        loops: [
          {
            id: "loop-valid-local-residue-cleanup",
            nodes: ["planner", "worker"],
            entryAgentId: "planner",
          },
          {
            id: "loop-stale-local-residue-cleanup",
            nodes: [residueAgentId, "worker"],
            entryAgentId: residueAgentId,
          },
        ],
      });

      await mkdir(join(OC, "research-lab"), { recursive: true });
      await writeFile(LOOP_SESSION_STATE_FILE, JSON.stringify({
        activeSession: {
          id: "LS-stale-local-residue-cleanup",
          loopId: "loop-stale-local-residue-cleanup",
          entryAgentId: residueAgentId,
          currentStage: residueAgentId,
          status: "active",
          nodes: [residueAgentId, "worker"],
          startedAt: Date.now(),
          updatedAt: Date.now(),
        },
        recentSessions: [
          {
            id: "LS-valid-local-residue-cleanup",
            loopId: "loop-valid-local-residue-cleanup",
            entryAgentId: "planner",
            currentStage: "planner",
            status: "concluded",
            nodes: ["planner", "worker"],
            startedAt: Date.now(),
            updatedAt: Date.now(),
          },
        ],
      }, null, 2), "utf8");

      const result = await hardDeleteAgentDefinition({
        agentId: residueAgentId,
        logger,
      });

      assert.equal(result.ok, true);
      assert.equal(result.workspaceDeleted, true);

      const afterDiscovery = await summarizeLocalAgentDiscovery({ includeLocalWorkspace: true });
      assert.equal(
        afterDiscovery.localWorkspaceResidue.some((entry) => entry.id === residueAgentId),
        false,
      );

      const graph = await loadGraph();
      assert.equal(
        graph.edges.some((edge) => edge.from === residueAgentId || edge.to === residueAgentId),
        false,
      );
      assert.equal(
        graph.edges.some((edge) => edge.from === "controller" && edge.to === "planner"),
        true,
      );

      const registry = await loadGraphLoopRegistry();
      assert.deepEqual(
        registry.loops.map((entry) => entry.id),
        ["loop-valid-local-residue-cleanup"],
      );

      const sessionState = await loadLoopSessionState();
      assert.equal(sessionState.activeSession, null);
      assert.deepEqual(
        sessionState.recentSessions.map((entry) => entry.id),
        ["LS-valid-local-residue-cleanup"],
      );

      await assert.rejects(() => readFile(sentinelFile, "utf8"));
    } finally {
      await saveConfig(JSON.parse(originalConfigRaw));
      await saveGraph(originalGraph);
      await saveGraphLoopRegistry(originalLoopRegistry);
      if (originalLoopSessionRaw == null) {
        await rm(LOOP_SESSION_STATE_FILE, { force: true });
      } else {
        await writeFile(LOOP_SESSION_STATE_FILE, originalLoopSessionRaw, "utf8");
      }
      await rm(workspaceDir, { recursive: true, force: true });
    }
  }));
});
