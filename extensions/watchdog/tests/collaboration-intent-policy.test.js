import test from "node:test";
import assert from "node:assert/strict";

import { AGENT_ROLE } from "../lib/agent/agent-metadata.js";
import { INTENT_TYPES } from "../lib/protocol/protocol-primitives.js";
import {
  COLLABORATION_INTENT_POLICY,
  listExposedToolIntents,
  listRolesForIntent,
} from "../lib/system-action/collaboration-intent-policy.js";
import {
  isActionAllowedForRole,
  listAllowedActionTypesForRole,
} from "../lib/system-action/system-action-role-policy.js";
import { listRuntimeHandledIntents } from "../lib/system-action/system-action-runtime.js";

test("every policy intent is a registered INTENT_TYPES value", () => {
  const known = new Set(Object.values(INTENT_TYPES));
  for (const row of COLLABORATION_INTENT_POLICY) {
    assert.ok(known.has(row.intent), `unknown intent in policy: ${row.intent}`);
  }
});

test("policy runtimeHandler flags agree with RUNTIME_SYSTEM_ACTION_HANDLERS", () => {
  const handled = new Set(listRuntimeHandledIntents());
  for (const row of COLLABORATION_INTENT_POLICY) {
    assert.equal(handled.has(row.intent), row.runtimeHandler,
      `runtimeHandler mismatch for ${row.intent}`);
  }
});

test("v1 tool face exposes exactly assign_task/wake_agent", () => {
  assert.deepEqual(listExposedToolIntents().sort(),
    ["assign_task", "wake_agent"]);
});

test("role matrix is derived from the policy table (single source)", () => {
  for (const row of COLLABORATION_INTENT_POLICY) {
    for (const role of Object.values(AGENT_ROLE)) {
      assert.equal(
        isActionAllowedForRole(role, row.intent),
        listRolesForIntent(row.intent).includes(role),
        `matrix/policy disagree: ${role} × ${row.intent}`,
      );
    }
  }
});

test("planner is limited to delegation", () => {
  assert.deepEqual(listAllowedActionTypesForRole(AGENT_ROLE.PLANNER).sort(),
    ["assign_task"]);
});
