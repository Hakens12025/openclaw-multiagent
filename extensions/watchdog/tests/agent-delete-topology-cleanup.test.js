import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// GroupSession 店同样沙箱化:本文件会直写 group_session_state.json 验证删 agent 的
// 级联剪枝,不能碰生产 research-lab。store 的路径是每次调用惰性解析的,在任何 IO 前
// 设置 env 即可生效。
process.env.OPENCLAW_GROUP_SESSION_DIR ||= mkdtempSync(join(tmpdir(), "openclaw-test-group-session-"));
const GROUP_SESSION_STATE_FILE = join(process.env.OPENCLAW_GROUP_SESSION_DIR, "group_session_state.json");

import { OC, agentWorkspace } from "../lib/state.js";
import {
  createAgentDefinition,
  deleteAgentDefinition,
  hardDeleteAgentDefinition,
} from "../lib/agent/admin/agent-admin-agent-operations.js";
import { saveConfig } from "../lib/agent/admin/agent-admin-store.js";
import { loadGraph } from "../lib/agent/agent-graph.js";
import { saveGraph as saveGraphUnattributed } from "../lib/agent/agent-graph-mutations.js";

// §13 整写门:测试夹具写图报身份(writer),edge 级差异日志可追溯到本文件。
const saveGraph = (graph) => saveGraphUnattributed(graph, { writer: "test:agent-delete-topology-cleanup.test.js" });
import { listDispatchTargetIds } from "../lib/routing/dispatch/dispatch-runtime-state.js";
import { loadGroupSessionState } from "../lib/agent/group-session-store.js";
import { summarizeLocalAgentDiscovery } from "../lib/agent/agent-enrollment-discovery.js";
import {
  buildAgentCard,
  syncAgentWorkspaceGuidance,
} from "../lib/workspace-guidance-writer.js";
import { runGlobalTestEnvironmentSerial } from "../lib/formal-runtime/test-locks.js";

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

// 级联剪枝的正向夹具:一条含待删 agent 的 active GroupSession(应被剪掉)+
// 一条只含存活 agent 的历史 GroupSession(应留下)。
async function writeGroupSessionFixture(staleAgentId, suffix) {
  await mkdir(process.env.OPENCLAW_GROUP_SESSION_DIR, { recursive: true });
  await writeFile(GROUP_SESSION_STATE_FILE, JSON.stringify({
    activeGroup: {
      id: `GS-stale-${suffix}`,
      groupId: `group-stale-${suffix}`,
      members: [staleAgentId, "worker"],
      entryAgentId: staleAgentId,
      outputMode: "aggregate",
      status: "executing",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    },
    recentGroups: [
      {
        id: `GS-valid-${suffix}`,
        groupId: `group-valid-${suffix}`,
        members: ["planner", "worker"],
        entryAgentId: "planner",
        outputMode: "aggregate",
        status: "concluded",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    ],
  }, null, 2), "utf8");
}

async function assertGroupSessionCascade(suffix) {
  const state = await loadGroupSessionState();
  assert.equal(state.activeGroup, null, "group session naming a deleted member must be pruned");
  assert.deepEqual(
    state.recentGroups.map((entry) => entry.id),
    [`GS-valid-${suffix}`],
    "group sessions whose members all survive must remain",
  );
}

async function restoreGroupSessionState(originalRaw) {
  if (originalRaw == null) {
    await rm(GROUP_SESSION_STATE_FILE, { force: true });
  } else {
    await writeFile(GROUP_SESSION_STATE_FILE, originalRaw, "utf8");
  }
}

async function withDeleteScenario(prefix, runAssertions) {
  return runGlobalTestEnvironmentSerial(() => runDeleteScenarioSerial(async () => {
    const tempAgentId = `${prefix}-${Date.now()}`;
    const workspaceDir = agentWorkspace(tempAgentId);
    const sentinelFile = join(workspaceDir, "output", "sentinel.txt");
    const originalConfigRaw = await readFile(join(OC, "openclaw.json"), "utf8");
    const originalGraph = await loadGraph();
    const originalGroupSessionRaw = await readFile(GROUP_SESSION_STATE_FILE, "utf8").catch(() => null);

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

      await writeGroupSessionFixture(tempAgentId, "delete-cleanup");

      await runAssertions({
        tempAgentId,
        workspaceDir,
        sentinelFile,
      });
    } finally {
      await saveConfig(JSON.parse(originalConfigRaw));
      await saveGraph(originalGraph);
      await restoreGroupSessionState(originalGroupSessionRaw);
      await rm(workspaceDir, { recursive: true, force: true });
    }
  }));
}

test("deleteAgentDefinition prunes graph edges and group sessions for deleted agents while keeping workspace files", { concurrency: false }, async () => {
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

    await assertGroupSessionCascade("delete-cleanup");

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

    await assertGroupSessionCascade("delete-cleanup");

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
    const originalGroupSessionRaw = await readFile(GROUP_SESSION_STATE_FILE, "utf8").catch(() => null);

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

      await writeGroupSessionFixture(residueAgentId, "local-residue-cleanup");

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

      await assertGroupSessionCascade("local-residue-cleanup");

      await assert.rejects(() => readFile(sentinelFile, "utf8"));
    } finally {
      await saveConfig(JSON.parse(originalConfigRaw));
      await saveGraph(originalGraph);
      await restoreGroupSessionState(originalGroupSessionRaw);
      await rm(workspaceDir, { recursive: true, force: true });
    }
  }));
});
