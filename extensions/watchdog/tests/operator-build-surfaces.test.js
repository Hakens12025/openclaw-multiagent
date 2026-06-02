import test from "node:test";
import assert from "node:assert/strict";

import { isOperatorExecutableSurfaceId } from "../lib/operator/operator-surface-policy.js";
import { findMissingRequiredAdminSurfaceFields } from "../lib/admin/admin-surface-registry.js";

// A1: agents.role + agents.constraints must be operator-executable — both are named in the
// operator-new-task build flow, and all-or-nothing plan validation means one non-executable
// step demotes the WHOLE build plan to advice_only. They are safe/changeset like their siblings.
test("A1: agents.role + agents.constraints are operator-executable", () => {
  assert.equal(isOperatorExecutableSurfaceId("agents.role"), true, "agents.role must be operator-executable");
  assert.equal(isOperatorExecutableSurfaceId("agents.constraints"), true, "agents.constraints must be operator-executable");
  // sanity: a destructive sibling stays as-is (still executable but explicit-confirm gated elsewhere)
  assert.equal(isOperatorExecutableSurfaceId("agents.skills"), true);
});

// A2: skills.create — the only domain-knowledge injection channel (通用机) — must carry a
// required-field schema so the planner is guided + the validator catches a missing field.
test("A2: skills.create requires skillId + description, body optional", () => {
  const missing = findMissingRequiredAdminSurfaceFields("skills.create", {}).map((f) => f.key).sort();
  assert.deepEqual(missing, ["description", "skillId"], "empty payload must report both required keys missing");
  assert.ok(!missing.includes("body"), "body must be optional");

  const complete = findMissingRequiredAdminSurfaceFields("skills.create", { skillId: "factor-x", description: "d" });
  assert.deepEqual(complete, [], "a complete payload must report no missing required fields");
});
