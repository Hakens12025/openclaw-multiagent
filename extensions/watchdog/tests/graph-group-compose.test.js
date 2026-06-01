import test from "node:test";
import assert from "node:assert/strict";

import { composeGraphGroup } from "../lib/admin/admin-surface-graph-operations.js";
import { loadGraph } from "../lib/agent/agent-graph.js";
import { saveGraph } from "../lib/agent/agent-graph-mutations.js";
import { clearActiveGroupSession } from "../lib/agent/group-session-store.js";

const logger = { info() {}, warn() {}, error() {} };

// graph.group.compose — AgentGroup 宏装配进图编辑器（#46 EDIT MODE 后端）。
// group 是宏：展开后消失在 graph(带 groupId 的内部边) + GroupSession + outputPolicies 投影里。
// 用真实 config agent（planner/worker/worker2）；自建 graph fixture + 用后恢复，隔离 live 拓扑。

test("composeGraphGroup 宏展开: 内部边带 groupId 进 graph + GroupSession 种子 + outputPolicies", async () => {
  const originalGraph = await loadGraph();
  const groupId = `test-group-${process.pid}`;
  try {
    await saveGraph({ edges: [] });
    const result = await composeGraphGroup({
      payload: {
        agents: ["planner", "worker", "worker2"],
        entry: "planner",
        internalEdges: [
          { from: "planner", to: "worker" },
          { from: "planner", to: "worker2" },
        ],
        outputMode: "aggregate",
        groupId,
      },
      logger,
    });

    assert.equal(result.ok, true);
    assert.equal(result.groupId, groupId);
    assert.equal(result.entryAgentId, "planner");
    assert.equal(result.outputMode, "aggregate");
    assert.equal(result.addedEdges.length, 2, "两条内部边应入图");

    // 边带 metadata.groupId（group 身份随边走，dispatcher 不感知 group）
    const graph = await loadGraph();
    const groupEdges = graph.edges.filter((e) => e.metadata?.groupId === groupId);
    assert.equal(groupEdges.length, 2, "图里应有 2 条带本 groupId 的边");
    assert.ok(groupEdges.every((e) => e.metadata?.direction === "internal"));

    // GroupSession 种子（运行层）
    assert.equal(result.groupSession?.groupId, groupId);
    assert.deepEqual(result.groupSession?.members, ["planner", "worker", "worker2"]);
    assert.equal(result.groupSession?.entryAgentId, "planner");
    assert.equal(result.groupSession?.outputMode, "aggregate");

    // outputPolicies 投影：entry 收口聚合，其余 passthrough
    assert.equal(result.outputPolicies.planner?.aggregateGroup, groupId);
    assert.equal(result.outputPolicies.worker?.format, "passthrough");
    assert.equal(result.outputPolicies.worker2?.format, "passthrough");
  } finally {
    await clearActiveGroupSession({ reason: "test_cleanup" }).catch(() => {});
    await saveGraph(originalGraph);
  }
});

test("composeGraphGroup 红线: 组内边端点非成员被丢弃(不开免授权暗门)", async () => {
  const originalGraph = await loadGraph();
  const groupId = `test-group-redline-${process.pid}`;
  try {
    await saveGraph({ edges: [] });
    const result = await composeGraphGroup({
      payload: {
        agents: ["planner", "worker"],
        entry: "planner",
        // planner→controller: controller 非组成员 → normalizeGroupSpec 丢弃该边
        internalEdges: [
          { from: "planner", to: "worker" },
          { from: "planner", to: "controller" },
        ],
        outputMode: "passthrough",
        groupId,
      },
      logger,
    });
    assert.equal(result.addedEdges.length, 1, "只有成员内的边入图");
    const graph = await loadGraph();
    assert.equal(
      graph.edges.some((e) => e.from === "planner" && e.to === "controller"),
      false,
      "非成员端点的边不得入图",
    );
  } finally {
    await clearActiveGroupSession({ reason: "test_cleanup" }).catch(() => {});
    await saveGraph(originalGraph);
  }
});

test("composeGraphGroup 拒绝: <2 成员 / 未知 agent / 重复成员", async () => {
  await assert.rejects(
    () => composeGraphGroup({ payload: { agents: ["planner"], outputMode: "aggregate" }, logger }),
    /at least 2 members/,
  );
  await assert.rejects(
    () => composeGraphGroup({ payload: { agents: ["planner", "no-such-agent-xyz"], outputMode: "aggregate" }, logger }),
    /unknown agent ids/,
  );
  await assert.rejects(
    () => composeGraphGroup({ payload: { agents: ["planner", "planner"], outputMode: "aggregate" }, logger }),
    /duplicate member/,
  );
});
