import test from "node:test";
import assert from "node:assert/strict";

import { buildOperatorKnowledgeContext } from "../lib/operator/operator-knowledge.js";

// token 少量: operator reads the live structure as ONE compact Agent Map fragment (id/role/model +
// in/out edges), not a verbose per-agent dump. Head is fixed; body is system-generated from live
// agents + graph.

test("agent-map: compact per-agent role/model + in/out edges", async () => {
  const agents = [
    { id: "writer", role: "worker", model: "ark/minimax" },
    { id: "reviewer1", role: "reviewer", model: "ark/minimax" },
  ];
  const graph = { edges: [{ from: "writer", to: "reviewer1" }, { from: "reviewer1", to: "writer" }] };
  const ctx = await buildOperatorKnowledgeContext({ requestText: "建结构 agent map 入边 出边 协作", agents, graph });
  const frag = ctx.selectedFragments.find((f) => f.id === "agent-map");
  assert.ok(frag, "agent-map fragment must be selected");
  assert.match(frag.summary, /writer\[worker\]/);
  assert.match(frag.summary, /reviewer1\[reviewer\]/);
  assert.match(frag.summary, /out→reviewer1/, "writer's out-edge to reviewer1");
  assert.match(frag.summary, /in←reviewer1/, "writer's in-edge from reviewer1");
});

test("agent-map: no registered agents → graceful summary, no crash", async () => {
  const ctx = await buildOperatorKnowledgeContext({ requestText: "agent map 结构 建立", agents: [], graph: { edges: [] } });
  const frag = ctx.selectedFragments.find((f) => f.id === "agent-map");
  assert.ok(frag);
  assert.match(frag.summary, /没有已注册 agent/);
});
