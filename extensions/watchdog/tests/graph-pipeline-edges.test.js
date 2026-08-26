/**
 * graph-pipeline-edges.test.js — 一张图两种读法的语义锁。
 *
 * 投递授权面(hasDirectedEdge)读全部边:传送带 dispatch / loop 路径的边覆盖校验,
 * 边越多越宽松。动态协作 FC 不读图,授权在 collaboration-intent-policy 角色表。
 * 自动选路面(getPipelineEdgesFrom)只读管线边:平台在 LLM 跑之前替 agent 决定
 * 下一跳,必须唯一确定。metadata.pipeline 把这两个相反的要求分开。
 *
 * Run: node --experimental-test-module-mocks --test tests/graph-pipeline-edges.test.js
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  getEdgesFrom,
  getPipelineEdgesFrom,
  hasDirectedEdge,
  normalizeGraphEdges,
} from "../lib/agent/agent-graph.js";

function graphOf(...edges) {
  return { edges: normalizeGraphEdges(edges) };
}

const MIXED = graphOf(
  { from: "controller", to: "planner", metadata: { pipeline: true } },
  { from: "controller", to: "worker" },
  { from: "controller", to: "reviewer1" },
);

test("pipeline edges narrow to the marked one while authorization still sees them all", () => {
  assert.deepEqual(
    getPipelineEdgesFrom(MIXED, "controller").map((edge) => edge.to),
    ["planner"],
    "自动选路只该看到管线边",
  );
  assert.equal(getEdgesFrom(MIXED, "controller").length, 3);
  for (const target of ["planner", "worker", "reviewer1"]) {
    assert.equal(
      hasDirectedEdge(MIXED, "controller", target),
      true,
      `FC 派工授权必须仍然覆盖 ${target} —— 管线标记不得收窄授权面`,
    );
  }
});

test("an unmarked topology keeps every edge as a routing candidate", () => {
  const unmarked = graphOf(
    { from: "planner", to: "worker" },
    { from: "planner", to: "worker2" },
  );
  assert.deepEqual(
    getPipelineEdgesFrom(unmarked, "planner").map((edge) => edge.to),
    ["worker", "worker2"],
    "一条都没标时全部边都是候选——reset 清空后重建的图必须保持原有行为",
  );

  const single = graphOf({ from: "reviewer1", to: "researcher1" });
  assert.deepEqual(getPipelineEdgesFrom(single, "reviewer1").map((edge) => edge.to), ["researcher1"]);
});

test("marking one edge restores a unique next hop for a fan-out agent", () => {
  // 这正是 planner 的形状:一条主路 + 三条只供 FC 显式派工的边。
  const fanOut = graphOf(
    { from: "planner", to: "worker", metadata: { pipeline: true } },
    { from: "planner", to: "worker2" },
    { from: "planner", to: "worker3" },
    { from: "planner", to: "reviewer1" },
  );
  assert.equal(getPipelineEdgesFrom(fanOut, "planner").length, 1, "扇出 agent 仍要有唯一下一跳");
  assert.equal(getPipelineEdgesFrom(fanOut, "planner")[0].to, "worker");
  assert.equal(getEdgesFrom(fanOut, "planner").length, 4);
});

test("normalization preserves the pipeline marker", () => {
  const [edge] = normalizeGraphEdges([{ from: "a", to: "b", metadata: { pipeline: true } }]);
  assert.equal(edge.metadata.pipeline, true, "归一化丢掉标记会让自动选路静默退回全边");
});

test("an agent with no outgoing edges yields no routing candidate", () => {
  assert.deepEqual(getPipelineEdgesFrom(graphOf({ from: "a", to: "b" }), "z"), []);
});
