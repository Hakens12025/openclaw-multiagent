import test from "node:test";
import assert from "node:assert/strict";

import {
  getCliSystemSurface,
  listCliSystemSurfaces,
  summarizeCliSystemSurfaces,
} from "../lib/cli-system/cli-surface-registry.js";

test("cli system registry merges hook observe and admin surfaces into one catalog", () => {
  const summary = summarizeCliSystemSurfaces();
  assert.equal(summary.counts.total > 0, true);
  assert.equal(summary.counts.byFamily.hook > 0, true);
  assert.equal(summary.counts.byFamily.observe > 0, true);
  assert.equal(summary.counts.byFamily.inspect > 0, true);
  assert.equal(summary.counts.byFamily.apply > 0, true);
  assert.equal(summary.counts.byFamily.verify > 0, true);
});

test("cli system registry resolves canonical hook and observe entries", () => {
  assert.equal(getCliSystemSurface("hook.before_tool_call")?.family, "hook");
  assert.equal(getCliSystemSurface("observe.track_progress")?.family, "observe");
});

test("cli system registry filters operator executable apply surfaces only", () => {
  const surfaces = listCliSystemSurfaces({
    family: "apply",
    operatorExecutable: true,
  });
  assert.equal(surfaces.some((surface) => surface.id === "agents.policy"), true);
  assert.equal(surfaces.some((surface) => surface.id === "runtime.reset"), false);
});
