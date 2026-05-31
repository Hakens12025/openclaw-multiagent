import test from "node:test";
import assert from "node:assert/strict";

import { AGENT_ROLE } from "../lib/agent/agent-metadata.js";
import {
  SYSTEM_ACTION_TYPES,
  isActionAllowedForRole,
  listAllowedActionTypesForRole,
  resolveDisallowedActionReason,
} from "../lib/system-action/system-action-role-policy.js";

test("canonical action matrix matches v5.1 Task 3 plan", () => {
  assert.deepEqual(
    listAllowedActionTypesForRole(AGENT_ROLE.BRIDGE).sort(),
    [SYSTEM_ACTION_TYPES.ASSIGN_TASK].sort(),
  );
  assert.deepEqual(
    listAllowedActionTypesForRole(AGENT_ROLE.PLANNER).sort(),
    [SYSTEM_ACTION_TYPES.ASSIGN_TASK, SYSTEM_ACTION_TYPES.REQUEST_REVIEW, SYSTEM_ACTION_TYPES.ADVANCE_LOOP].sort(),
  );
  assert.deepEqual(
    listAllowedActionTypesForRole(AGENT_ROLE.EXECUTOR),
    [SYSTEM_ACTION_TYPES.REQUEST_REVIEW],
  );
  assert.deepEqual(
    listAllowedActionTypesForRole(AGENT_ROLE.RESEARCHER),
    [SYSTEM_ACTION_TYPES.REQUEST_REVIEW],
  );
  assert.deepEqual(
    listAllowedActionTypesForRole(AGENT_ROLE.REVIEWER).sort(),
    [SYSTEM_ACTION_TYPES.REQUEST_REVIEW, SYSTEM_ACTION_TYPES.ADVANCE_LOOP].sort(),
  );
  assert.deepEqual(
    listAllowedActionTypesForRole(AGENT_ROLE.AGENT).sort(),
    [
      SYSTEM_ACTION_TYPES.ASSIGN_TASK,
      SYSTEM_ACTION_TYPES.REQUEST_REVIEW,
      SYSTEM_ACTION_TYPES.WAKE_AGENT,
      SYSTEM_ACTION_TYPES.START_LOOP,
      SYSTEM_ACTION_TYPES.ADVANCE_LOOP,
    ].sort(),
  );
});

test("bridge can delegate (assign_task) but cannot review or advance_loop", () => {
  assert.equal(isActionAllowedForRole(AGENT_ROLE.BRIDGE, SYSTEM_ACTION_TYPES.ASSIGN_TASK), true);
  assert.equal(isActionAllowedForRole(AGENT_ROLE.BRIDGE, SYSTEM_ACTION_TYPES.REQUEST_REVIEW), false);
  assert.equal(isActionAllowedForRole(AGENT_ROLE.BRIDGE, SYSTEM_ACTION_TYPES.ADVANCE_LOOP), false);
  assert.equal(isActionAllowedForRole(AGENT_ROLE.BRIDGE, SYSTEM_ACTION_TYPES.WAKE_AGENT), false);
});

test("disallowed-action reason surface names the role and lists allowed actions", () => {
  const reason = resolveDisallowedActionReason(AGENT_ROLE.BRIDGE, SYSTEM_ACTION_TYPES.REQUEST_REVIEW);
  assert.match(reason, /bridge/);
  assert.match(reason, /assign_task/);
});

test("unregistered role returns empty allowed set", () => {
  assert.deepEqual(listAllowedActionTypesForRole("not-a-role"), []);
  assert.equal(isActionAllowedForRole("not-a-role", SYSTEM_ACTION_TYPES.ASSIGN_TASK), false);
});
