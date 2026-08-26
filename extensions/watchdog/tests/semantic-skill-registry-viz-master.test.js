import test from "node:test";
import assert from "node:assert/strict";

import {
  getSemanticSkillSpec,
  listForcedPlatformSkillRefs,
  listOperatorSemanticSkillRefs,
  listRoleSemanticSkillRefs,
} from "../lib/prompt/semantic-skill-registry.js";

test("chart-build is a viz_master_default semantic skill spec", () => {
  const spec = getSemanticSkillSpec("chart-build");
  assert.ok(spec, "chart-build spec must be registered");
  assert.equal(spec.defaultInjection, "viz_master_default");
  assert.equal(spec.audience, "viz_master_only");
  assert.ok(spec.toolRefs.includes("apply.chart_create"));
  assert.ok(spec.toolRefs.includes("inspect.charts"));
});

test("chart-build does NOT leak to operator / forced-platform / role injection", () => {
  // no-leak guard: viz_master_default is exclusive to viz-master.
  assert.equal(listForcedPlatformSkillRefs().includes("chart-build"), false);
  assert.equal(listOperatorSemanticSkillRefs().includes("chart-build"), false);
  for (const role of ["planner", "executor", "researcher", "bridge", "agent"]) {
    assert.equal(
      listRoleSemanticSkillRefs(role).includes("chart-build"),
      false,
      `role ${role} must not auto-inject chart-build`,
    );
  }
});
