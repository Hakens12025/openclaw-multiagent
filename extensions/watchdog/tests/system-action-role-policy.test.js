import test from "node:test";
import assert from "node:assert/strict";

import { AGENT_ROLE } from "../lib/agent/agent-metadata.js";
import { INTENT_TYPES } from "../lib/protocol/protocol-primitives.js";
import {
  listExposedToolIntents,
  listRolesForIntent,
} from "../lib/system-action/collaboration-intent-policy.js";
import {
  SYSTEM_ACTION_TYPES,
  isActionAllowedForRole,
  listAllowedActionTypesForRole,
  resolveDisallowedActionReason,
} from "../lib/system-action/system-action-role-policy.js";

test("canonical action matrix matches the collaboration-intent-policy table", () => {
  assert.deepEqual(
    listAllowedActionTypesForRole(AGENT_ROLE.BRIDGE).sort(),
    [SYSTEM_ACTION_TYPES.ASSIGN_TASK].sort(),
  );
  assert.deepEqual(
    listAllowedActionTypesForRole(AGENT_ROLE.PLANNER).sort(),
    [SYSTEM_ACTION_TYPES.ASSIGN_TASK].sort(),
  );
  assert.deepEqual(listAllowedActionTypesForRole(AGENT_ROLE.EXECUTOR), []);
  assert.deepEqual(listAllowedActionTypesForRole(AGENT_ROLE.RESEARCHER), []);
  assert.deepEqual(
    listAllowedActionTypesForRole(AGENT_ROLE.AGENT).sort(),
    [
      SYSTEM_ACTION_TYPES.ASSIGN_TASK,
      SYSTEM_ACTION_TYPES.WAKE_AGENT,
    ].sort(),
  );
});

test("bridge can delegate (assign_task) but cannot wake", () => {
  assert.equal(isActionAllowedForRole(AGENT_ROLE.BRIDGE, SYSTEM_ACTION_TYPES.ASSIGN_TASK), true);
  assert.equal(isActionAllowedForRole(AGENT_ROLE.BRIDGE, SYSTEM_ACTION_TYPES.WAKE_AGENT), false);
});

test("disallowed-action reason surface names the role and lists allowed actions", () => {
  const reason = resolveDisallowedActionReason(AGENT_ROLE.BRIDGE, SYSTEM_ACTION_TYPES.WAKE_AGENT);
  assert.match(reason, /bridge/);
  assert.match(reason, /assign_task/);
});

// 缓建 intent 钉死:create_task 对每个已注册角色都是 known-but-denied
// (collaboration-intent-policy roles=[]),也从未作为协作 FC 工具暴露。
// collab 预设 create-task-denied 案(E-SYSACTION-002)的单元级对照面。
test("create_task stays known-but-denied for every registered role", () => {
  for (const role of Object.values(AGENT_ROLE)) {
    assert.equal(
      isActionAllowedForRole(role, INTENT_TYPES.CREATE_TASK),
      false,
      `role ${role} must reject create_task while the intent stays deferred-build`,
    );
    assert.match(resolveDisallowedActionReason(role, INTENT_TYPES.CREATE_TASK), /create_task/);
  }
  assert.deepEqual(listRolesForIntent(INTENT_TYPES.CREATE_TASK), []);
  assert.equal(listExposedToolIntents().includes(INTENT_TYPES.CREATE_TASK), false);
});

test("unregistered role returns empty allowed set", () => {
  assert.deepEqual(listAllowedActionTypesForRole("not-a-role"), []);
  assert.equal(isActionAllowedForRole("not-a-role", SYSTEM_ACTION_TYPES.ASSIGN_TASK), false);
});
