import test from "node:test";
import assert from "node:assert/strict";

import {
  normalizeSystemActionResults,
  selectPrimarySystemActionResult,
} from "../lib/system-action/system-action-runtime-ledger.js";
import { buildSystemActionContractFields } from "../lib/lifecycle/agent-end/terminal.js";
import { SYSTEM_ACTION_STATUS } from "../lib/core/runtime-status.js";

const deferredAssign = {
  actionType: "assign_task",
  status: SYSTEM_ACTION_STATUS.DISPATCHED,
  deferredCompletion: true,
  targetAgent: "worker2",
  contractId: "DIRECT-1",
  deliveryTicketId: "SADT-1",
};
const failedWake = {
  actionType: "wake_agent",
  status: SYSTEM_ACTION_STATUS.INVALID_STATE,
  error: "graph disallows wake_agent from worker to planner",
};
const okWake = {
  actionType: "wake_agent",
  status: SYSTEM_ACTION_STATUS.DISPATCHED,
  targetAgent: "worker2",
};

test("normalizeSystemActionResults tolerates legacy single-object and null", () => {
  assert.deepEqual(normalizeSystemActionResults(null), []);
  assert.deepEqual(normalizeSystemActionResults(deferredAssign), [deferredAssign]);
  assert.deepEqual(normalizeSystemActionResults([deferredAssign, failedWake]), [deferredAssign, failedWake]);
  assert.deepEqual(normalizeSystemActionResults([null, okWake]), [okWake]);
});

test("selectPrimarySystemActionResult: deferred wins over failure (resume machinery depends on COMPLETED-deferred)", () => {
  assert.equal(selectPrimarySystemActionResult([failedWake, deferredAssign]), deferredAssign);
  assert.equal(selectPrimarySystemActionResult([deferredAssign, failedWake]), deferredAssign);
});

test("selectPrimarySystemActionResult: no deferred → first actionable result; empty → null", () => {
  assert.equal(selectPrimarySystemActionResult([failedWake, okWake]), failedWake);
  assert.equal(selectPrimarySystemActionResult([okWake]), okWake);
  assert.equal(selectPrimarySystemActionResult([]), null);
  assert.equal(selectPrimarySystemActionResult(null), null);
});

test("buildSystemActionContractFields persists every action as an array entry", () => {
  const fields = buildSystemActionContractFields([deferredAssign, failedWake], {
    deferredFollowUp: { type: "assign_task", deliveryTicketId: "SADT-1", mode: "delivery" },
  });
  assert.ok(Array.isArray(fields.systemAction));
  assert.equal(fields.systemAction.length, 2);
  assert.equal(fields.systemAction[0].type, "assign_task");
  assert.equal(fields.systemAction[0].contractId, "DIRECT-1");
  assert.equal(fields.systemAction[1].type, "wake_agent");
  assert.match(fields.systemAction[1].error || "", /graph disallows/);
  assert.equal(fields.followUp?.deliveryTicketId, "SADT-1");
});

test("buildSystemActionContractFields drops no_action entries and stays empty on none", () => {
  assert.deepEqual(
    buildSystemActionContractFields([{ status: SYSTEM_ACTION_STATUS.NO_ACTION }]),
    {},
  );
  assert.deepEqual(buildSystemActionContractFields(null), {});
  // 旧单对象入参仍可写(迁移期调用方兼容)
  const legacy = buildSystemActionContractFields(okWake);
  assert.equal(legacy.systemAction.length, 1);
  assert.equal(legacy.systemAction[0].type, "wake_agent");
});
