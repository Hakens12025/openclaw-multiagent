import test from "node:test";
import assert from "node:assert/strict";

const previousSurfaceDisplay = globalThis.OpenClawSurfaceDisplay;

await import("../dashboard-surface-display.js");

const helpers = globalThis.OpenClawSurfaceDisplay;

test("dashboard surface display builds control namespace from canonical ids", () => {
  assert.ok(helpers, "surface display helpers should be registered on globalThis");
  assert.equal(
    helpers.buildSurfaceDisplayId("graph.edge.add"),
    "control:graph.edge.add",
  );
  assert.equal(
    helpers.buildSurfaceDisplayId({ id: "runtime.loop.start" }),
    "control:runtime.loop.start",
  );
});

test("dashboard surface display prefers explicit display ids when present", () => {
  assert.equal(
    helpers.resolveSurfaceDisplayId({
      id: "graph.edge.add",
      displayId: "control:graph.edge.add",
    }),
    "control:graph.edge.add",
  );
  assert.equal(
    helpers.resolveSurfaceDisplayId("hook.before_tool_call"),
    "control:hook.before_tool_call",
  );
});

test("dashboard surface display formats missing values safely", () => {
  assert.equal(helpers.formatSurfaceDisplayId(null), "--");
  assert.equal(helpers.formatSurfaceDisplayId(""), "--");
});

test.after(() => {
  if (previousSurfaceDisplay === undefined) {
    delete globalThis.OpenClawSurfaceDisplay;
    return;
  }
  globalThis.OpenClawSurfaceDisplay = previousSurfaceDisplay;
});
