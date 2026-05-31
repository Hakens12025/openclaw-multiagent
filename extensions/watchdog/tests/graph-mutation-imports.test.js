import test from "node:test";
import assert from "node:assert/strict";

test("admin graph operations import mutation helpers from graph mutation module", async () => {
  const mod = await import("../lib/admin/admin-surface-graph-operations.js");

  assert.equal(typeof mod.mutateGraphEdge, "function");
  assert.equal(typeof mod.composeGraphLoop, "function");
});

test("agent admin operations import prune helper from graph mutation module", async () => {
  const mod = await import("../lib/agent/agent-admin-agent-operations.js");
  assert.equal(typeof mod.deleteAgentDefinition, "function");
});
