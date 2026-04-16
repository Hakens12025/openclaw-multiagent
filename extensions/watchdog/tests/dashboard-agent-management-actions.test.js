import test from "node:test";
import assert from "node:assert/strict";

import {
  buildAgentDeleteConfirmation,
  resolveAgentRemovalAction,
} from "../dashboard-agent-management-actions.js";

test("resolveAgentRemovalAction returns canonical delete semantics", () => {
  assert.deepEqual(resolveAgentRemovalAction("delete", "worker-e"), {
    mode: "delete",
    path: "/watchdog/agents/delete",
    eventType: "agent_deleted",
    successToast: "已从系统移除: worker-e",
    busyLabel: "REMOVING...",
  });
});

test("resolveAgentRemovalAction returns canonical hard-delete semantics", () => {
  assert.deepEqual(resolveAgentRemovalAction("hard_delete", "worker-e"), {
    mode: "hard_delete",
    path: "/watchdog/agents/hard-delete",
    eventType: "agent_hard_deleted",
    successToast: "已彻底删除: worker-e",
    busyLabel: "DELETING...",
  });
});

test("buildAgentDeleteConfirmation explains non-destructive delete semantics", () => {
  const message = buildAgentDeleteConfirmation("worker-e", "delete");

  assert.match(message, /只从系统注册中移除/i);
  assert.match(message, /不删除本地 workspace/i);
  assert.doesNotMatch(message, /不可恢复/i);
});

test("buildAgentDeleteConfirmation explains hard-delete scope", () => {
  const message = buildAgentDeleteConfirmation("worker-e", "hard_delete");

  assert.match(message, /本地 workspace 会被删除/i);
  assert.match(message, /agent-card\.json/i);
  assert.match(message, /inbox/i);
  assert.match(message, /output/i);
  assert.match(message, /不可恢复/i);
});
