import test from "node:test";
import assert from "node:assert/strict";

import {
  getCliSystemSurface,
  summarizeCliSystemSurfaces,
} from "../lib/cli-system/cli-surface-registry.js";
import { buildOperatorSnapshot } from "../lib/operator/operator-snapshot.js";

test("cli-system surface registry provides hook observe and admin surface projections", () => {
  const summary = summarizeCliSystemSurfaces();

  assert.equal(summary.counts.byFamily.hook > 0, true);
  assert.equal(summary.counts.byFamily.observe > 0, true);
  assert.equal(summary.counts.byFamily.apply > 0, true);
  assert.equal(getCliSystemSurface("hook.before_tool_call")?.displayId, "control:hook.before_tool_call");
  assert.equal(getCliSystemSurface("graph.edge.add")?.source, "admin_surface");
});

test("operator snapshot imports cli-system surface projection", async () => {
  const snapshot = await buildOperatorSnapshot({ listLimit: 1 });

  assert.equal(snapshot.cliSystem.counts.byFamily.hook > 0, true);
  assert.equal(snapshot.cliSystem.counts.byFamily.observe > 0, true);
  assert.equal(Array.isArray(snapshot.cliSystem.surfaces), true);
});
