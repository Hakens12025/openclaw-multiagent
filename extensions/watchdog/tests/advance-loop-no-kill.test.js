// Bug fix test: advance_loop via system_action must NOT produce terminalOutcome=FAILED
// Ref: lib/system-action/system-action-runtime.js:289
//      lib/system-action/system-action-runtime-ledger.js:deriveSystemActionTerminalOutcome
import test from "node:test";
import assert from "node:assert/strict";

import { SYSTEM_ACTION_STATUS } from "../lib/core/runtime-status.js";
import { INTENT_TYPES } from "../lib/protocol-primitives.js";
import { systemActionDispatch } from "../lib/system-action/system-action-runtime.js";
import {
  deriveSystemActionTerminalOutcome,
  isDeferredSystemActionAccepted,
} from "../lib/system-action/system-action-runtime-ledger.js";

const logger = { info() {}, warn() {}, error() {} };

const FAKE_CONTRACT = {
  id: "test-contract-1",
  replyTo: null,
  operatorContext: null,
};

test("advance_loop via systemActionDispatch returns a non-FAILED status", async () => {
  const normalizedAction = {
    type: INTENT_TYPES.ADVANCE_LOOP,
    params: {},
  };

  const result = await systemActionDispatch(normalizedAction, {
    agentId: "planner",
    logger,
    contractData: FAKE_CONTRACT,
    sessionKey: "test-session",
    api: null,
  });

  assert.ok(result, "handler must return a result object");
  assert.notEqual(
    result.status,
    SYSTEM_ACTION_STATUS.INVALID_STATE,
    "advance_loop must not return INVALID_STATE (that path was the bug)",
  );
  assert.notEqual(
    result.status,
    SYSTEM_ACTION_STATUS.NOT_IMPLEMENTED,
    "advance_loop must not return NOT_IMPLEMENTED",
  );
});

test("advance_loop result does NOT produce terminalOutcome=FAILED via deriveSystemActionTerminalOutcome", async () => {
  const normalizedAction = {
    type: INTENT_TYPES.ADVANCE_LOOP,
    params: {},
  };

  const result = await systemActionDispatch(normalizedAction, {
    agentId: "planner",
    logger,
    contractData: FAKE_CONTRACT,
    sessionKey: "test-session",
    api: null,
  });

  assert.ok(result, "handler must return a result object");

  const terminalDerivation = deriveSystemActionTerminalOutcome(result, null);

  // The contract must NOT be killed with FAILED.
  // Either terminalDerivation is null (deferred/NO_ACTION paths) or status is not FAILED.
  if (terminalDerivation !== null) {
    assert.notEqual(
      terminalDerivation.terminalStatus,
      "failed",
      `advance_loop must not terminate contract as FAILED; got terminalStatus=${terminalDerivation.terminalStatus}`,
    );
  }
});

test("advance_loop result: isDeferredSystemActionAccepted or NO_ACTION path prevents contract kill", async () => {
  const normalizedAction = {
    type: INTENT_TYPES.ADVANCE_LOOP,
    params: {},
  };

  const result = await systemActionDispatch(normalizedAction, {
    agentId: "reviewer",
    logger,
    contractData: FAKE_CONTRACT,
    sessionKey: "test-session",
    api: null,
  });

  assert.ok(result, "handler must return a result object");

  // Either the result is deferred-accepted OR the status is NO_ACTION (both skip terminal kill).
  const isAccepted = isDeferredSystemActionAccepted(result);
  const isNoAction = result.status === SYSTEM_ACTION_STATUS.NO_ACTION;

  assert.ok(
    isAccepted || isNoAction,
    `advance_loop result must be deferred-accepted or NO_ACTION to avoid contract kill; got status=${result.status}, deferredCompletion=${result.deferredCompletion}`,
  );
});
