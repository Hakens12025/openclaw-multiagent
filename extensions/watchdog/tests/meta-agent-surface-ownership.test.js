import test from "node:test";
import assert from "node:assert/strict";

import {
  META_AGENT_SURFACE_OWNERSHIP,
  NON_TRUTH_BACKED_FAMILIES,
  assertActorOwnsSurface,
  filterExecutableSurfacesForActor,
  resolveSurfaceFamily,
} from "../lib/cli-system/meta-agent-surface-ownership.js";

test("operator owns every surface family (universal)", () => {
  assert.equal(META_AGENT_SURFACE_OWNERSHIP.operator, "*");
  assert.doesNotThrow(() => assertActorOwnsSurface("operator", "apply.knowledge_add"));
  assert.doesNotThrow(() => assertActorOwnsSurface("operator", "graph.edge.add"));
  assert.doesNotThrow(() => assertActorOwnsSurface("operator", "agents.create"));
});

test("non meta-agent actors throw with a meta-agent actor message", () => {
  assert.throws(
    () => assertActorOwnsSurface(null, "agents.create"),
    /meta-agent actor/u,
  );
  assert.throws(
    () => assertActorOwnsSurface("worker-d", "agents.create"),
    /meta-agent actor/u,
  );
});

test("viz-master owns only the chart family plus shared verify infra", () => {
  assert.doesNotThrow(() => assertActorOwnsSurface("viz-master", "apply.chart_create"));
  // test_run is a shared family any meta-agent may use.
  assert.doesNotThrow(() => assertActorOwnsSurface("viz-master", "test_runs.start"));

  assert.throws(
    () => assertActorOwnsSurface("viz-master", "agents.create"),
    /does not own surface family "agent"/u,
  );
  assert.throws(
    () => assertActorOwnsSurface("viz-master", "graph.edge.add"),
    /does not own surface family "graph"/u,
  );
  assert.throws(
    () => assertActorOwnsSurface("viz-master", "apply.knowledge_add"),
    /does not own surface family "knowledge"/u,
  );
});

test("resolveSurfaceFamily maps surfaces to their admin-surface kind", () => {
  assert.equal(resolveSurfaceFamily("apply.chart_create"), "chart");
  assert.equal(resolveSurfaceFamily("apply.knowledge_add"), "knowledge");
  assert.equal(resolveSurfaceFamily("graph.edge.add"), "graph");
});

test("non-truth-backed families cover content/data stores but not graph", () => {
  assert.equal(NON_TRUTH_BACKED_FAMILIES.has("knowledge"), true);
  assert.equal(NON_TRUTH_BACKED_FAMILIES.has("chart"), true);
  assert.equal(NON_TRUTH_BACKED_FAMILIES.has("graph"), false);
});

test("filterExecutableSurfacesForActor: operator passes every surface through", () => {
  const surfaces = [
    { id: "apply.chart_create" },
    { id: "agents.create" },
    { id: "graph.edge.add" },
    { id: "test_runs.start" },
  ];
  const filtered = filterExecutableSurfacesForActor("operator", surfaces);
  assert.deepEqual(filtered, surfaces);
});

test("filterExecutableSurfacesForActor: viz-master keeps chart + shared verify, drops agent/graph", () => {
  const surfaces = [
    { id: "apply.chart_create" },
    { id: "apply.chart_move" },
    { id: "agents.create" },
    { id: "graph.edge.add" },
    { id: "apply.knowledge_add" },
    { id: "test_runs.start" },
  ];
  const filtered = filterExecutableSurfacesForActor("viz-master", surfaces).map((s) => s.id);
  assert.deepEqual(filtered, ["apply.chart_create", "apply.chart_move", "test_runs.start"]);
});

test("filterExecutableSurfacesForActor: non meta-agent actor gets nothing", () => {
  const surfaces = [{ id: "apply.chart_create" }, { id: "agents.create" }];
  assert.deepEqual(filterExecutableSurfacesForActor("worker-d", surfaces), []);
  assert.deepEqual(filterExecutableSurfacesForActor(null, surfaces), []);
});
