import test from "node:test";
import assert from "node:assert/strict";

import {
  normalizeGroupSpec,
  expandAgentGroup,
} from "../lib/agent/agent-group-spec.js";

// P6-Phase2: AgentGroup = 宏（macro），非 runtime 对象。展开后消失在
// graph(EdgeSpec) + binding(outputPolicy) 里。GroupSpec(装配层)在此 validate +
// 展开；GroupSession(运行层)在 group-session-store.js，两者分开不融合。

// ── normalizeGroupSpec validate ───────────────────────────────────────────────

test("normalizeGroupSpec keeps id/members/entry/internalEdges/outputMode", () => {
  const spec = normalizeGroupSpec({
    id: "review-team",
    members: ["r1", "r2", "r3"],
    entry: "r1",
    internalEdges: [{ from: "r1", to: "r2" }, { from: "r2", to: "r3" }],
    outputMode: "passthrough",
  });
  assert.equal(spec.id, "review-team");
  assert.deepEqual(spec.members, ["r1", "r2", "r3"]);
  assert.equal(spec.entry, "r1");
  assert.deepEqual(spec.internalEdges, [{ from: "r1", to: "r2" }, { from: "r2", to: "r3" }]);
  assert.equal(spec.outputMode, "passthrough");
});

test("normalizeGroupSpec rejects specs without id or <2 members", () => {
  assert.equal(normalizeGroupSpec(null), null);
  assert.equal(normalizeGroupSpec({ members: ["a", "b"] }), null, "no id");
  assert.equal(normalizeGroupSpec({ id: "g", members: ["a"] }), null, "single member");
  assert.equal(normalizeGroupSpec({ id: "g", members: [] }), null, "no members");
});

test("normalizeGroupSpec defaults outputMode to aggregate and entry to first member", () => {
  const spec = normalizeGroupSpec({ id: "g", members: ["a", "b"] });
  assert.equal(spec.outputMode, "aggregate");
  assert.equal(spec.entry, "a");
});

test("normalizeGroupSpec rejects invalid outputMode enum", () => {
  assert.equal(normalizeGroupSpec({ id: "g", members: ["a", "b"], outputMode: "nope" }), null);
});

test("normalizeGroupSpec drops internalEdges whose endpoints are not members", () => {
  const spec = normalizeGroupSpec({
    id: "g",
    members: ["a", "b"],
    internalEdges: [{ from: "a", to: "b" }, { from: "a", to: "outsider" }],
  });
  assert.deepEqual(spec.internalEdges, [{ from: "a", to: "b" }]);
});

test("normalizeGroupSpec coerces entry to first member when entry is not a member", () => {
  const spec = normalizeGroupSpec({ id: "g", members: ["a", "b"], entry: "ghost" });
  assert.equal(spec.entry, "a");
});

// ── expandAgentGroup: passthrough ─────────────────────────────────────────────

test("passthrough expands declared internalEdges to explicit EdgeSpec with groupId", () => {
  const { edges } = expandAgentGroup({
    id: "review-team",
    members: ["r1", "r2", "r3"],
    entry: "r1",
    internalEdges: [{ from: "r1", to: "r2" }, { from: "r2", to: "r3" }],
    outputMode: "passthrough",
  });
  assert.deepEqual(edges, [
    { from: "r1", to: "r2", label: null, metadata: { groupId: "review-team", direction: "internal", outputMode: "passthrough" } },
    { from: "r2", to: "r3", label: null, metadata: { groupId: "review-team", direction: "internal", outputMode: "passthrough" } },
  ]);
});

test("passthrough sets every member outputPolicy to passthrough (members flow downstream directly)", () => {
  const { outputPolicies } = expandAgentGroup({
    id: "g",
    members: ["a", "b"],
    internalEdges: [{ from: "a", to: "b" }],
    outputMode: "passthrough",
  });
  assert.deepEqual(outputPolicies, {
    a: { format: "passthrough" },
    b: { format: "passthrough" },
  });
});

// ── expandAgentGroup: aggregate ───────────────────────────────────────────────

test("aggregate fans declared internalEdges out and marks entry outputPolicy aggregateGroup", () => {
  const { edges, outputPolicies } = expandAgentGroup({
    id: "analysis",
    members: ["a", "b", "c"],
    entry: "a",
    internalEdges: [{ from: "a", to: "b" }, { from: "a", to: "c" }],
    outputMode: "aggregate",
  });
  // 内部边都是显式 EdgeSpec 带 groupId
  for (const e of edges) {
    assert.equal(e.metadata.groupId, "analysis");
    assert.equal(e.metadata.direction, "internal");
    assert.equal(e.metadata.outputMode, "aggregate");
  }
  // aggregate：组级出边等齐 → entry(组级聚合点)的 outputPolicy 带 aggregateGroup
  assert.deepEqual(outputPolicies.a, { format: "contract-json", aggregateGroup: "analysis" });
  // 非聚合成员是 passthrough
  assert.deepEqual(outputPolicies.b, { format: "passthrough" });
  assert.deepEqual(outputPolicies.c, { format: "passthrough" });
});

// ── expandAgentGroup: race ────────────────────────────────────────────────────

test("race expands internalEdges and tags outputMode=race on edges", () => {
  const { edges } = expandAgentGroup({
    id: "fastest",
    members: ["a", "b"],
    internalEdges: [{ from: "a", to: "b" }],
    outputMode: "race",
  });
  assert.equal(edges[0].metadata.outputMode, "race");
  assert.equal(edges[0].metadata.groupId, "fastest");
});

// ── expandAgentGroup: GroupSession descriptor (spec/session separation) ────────

test("expandAgentGroup emits a GroupSession descriptor distinct from the spec", () => {
  const spec = {
    id: "g",
    members: ["a", "b"],
    entry: "a",
    internalEdges: [{ from: "a", to: "b" }],
    outputMode: "aggregate",
  };
  const { groupSession } = expandAgentGroup(spec);
  assert.equal(groupSession.groupId, "g");
  assert.deepEqual(groupSession.members, ["a", "b"]);
  assert.equal(groupSession.entryAgentId, "a");
  assert.equal(groupSession.outputMode, "aggregate");
  // session descriptor 不是 spec 本体（运行层 vs 装配层分开）
  assert.notStrictEqual(groupSession, spec);
  assert.equal(groupSession.internalEdges, undefined, "session descriptor 不携带装配层 internalEdges");
});

test("expandAgentGroup on an invalid spec yields empty edges and null session (no silent guesses)", () => {
  const result = expandAgentGroup({ id: "g", members: ["only-one"] });
  assert.deepEqual(result.edges, []);
  assert.deepEqual(result.outputPolicies, {});
  assert.equal(result.groupSession, null);
});

// ── red line: no auth bypass — internal edges are explicit EdgeSpec ────────────

test("RED LINE: all internal edges are explicit from/to EdgeSpec (no implicit group channel)", () => {
  const { edges } = expandAgentGroup({
    id: "g",
    members: ["a", "b", "c"],
    internalEdges: [{ from: "a", to: "b" }, { from: "b", to: "c" }],
    outputMode: "passthrough",
  });
  // 每条组内边都必须是显式 from→to（经既有 graph 授权），不存在免授权暗门
  for (const e of edges) {
    assert.ok(typeof e.from === "string" && e.from, "edge has explicit from");
    assert.ok(typeof e.to === "string" && e.to, "edge has explicit to");
  }
  assert.equal(edges.length, 2);
});
