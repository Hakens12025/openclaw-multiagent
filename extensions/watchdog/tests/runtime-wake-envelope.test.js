import test from "node:test";
import assert from "node:assert/strict";

import {
  WAKE_SEMANTIC_TYPE,
  WAKE_ENVELOPE_VERSION,
  buildRuntimeWakeEnvelope,
  validateWakeEnvelope,
  normalizeWakeEnvelope,
  renderWakeEnvelopeToText,
  listRequiredFieldsForSemantic,
  isKnownWakeSemanticType,
} from "../lib/transport/runtime-wake-envelope.js";
import { runtimeWakeAgentDetailed } from "../lib/transport/runtime-wake-transport.js";

test("execution_contract requires contractId", () => {
  assert.throws(() => buildRuntimeWakeEnvelope({
    semanticType: WAKE_SEMANTIC_TYPE.EXECUTION_CONTRACT,
    targetAgentId: "worker",
  }), /contractId/);
  const envelope = buildRuntimeWakeEnvelope({
    semanticType: WAKE_SEMANTIC_TYPE.EXECUTION_CONTRACT,
    targetAgentId: "worker",
    contractId: "TC-123",
  });
  assert.equal(envelope.version, WAKE_ENVELOPE_VERSION);
  assert.equal(envelope.semanticType, WAKE_SEMANTIC_TYPE.EXECUTION_CONTRACT);
  assert.equal(envelope.contractId, "TC-123");
  assert.equal(envelope.targetAgentId, "worker");
  assert.ok(typeof envelope.renderText === "string" && envelope.renderText.length > 0);
});

test("direct_request_resume requires envelopeId, not contractId", () => {
  assert.throws(() => buildRuntimeWakeEnvelope({
    semanticType: WAKE_SEMANTIC_TYPE.DIRECT_REQUEST_RESUME,
    targetAgentId: "worker",
  }), /envelopeId/);
  const envelope = buildRuntimeWakeEnvelope({
    semanticType: WAKE_SEMANTIC_TYPE.DIRECT_REQUEST_RESUME,
    targetAgentId: "worker",
    envelopeId: "env-abc",
  });
  assert.equal(envelope.envelopeId, "env-abc");
  assert.equal(envelope.contractId, undefined);
});

test("assign_task_dispatch requires sourceAgentId and keeps deliveryTicketId optional", () => {
  assert.throws(() => buildRuntimeWakeEnvelope({
    semanticType: WAKE_SEMANTIC_TYPE.ASSIGN_TASK_DISPATCH,
    targetAgentId: "worker",
  }), /sourceAgentId/);
  const envelope = buildRuntimeWakeEnvelope({
    semanticType: WAKE_SEMANTIC_TYPE.ASSIGN_TASK_DISPATCH,
    targetAgentId: "worker",
    sourceAgentId: "controller",
  });
  assert.equal(envelope.sourceAgentId, "controller");
  assert.equal(envelope.deliveryTicketId, undefined);
  const withTicket = buildRuntimeWakeEnvelope({
    semanticType: WAKE_SEMANTIC_TYPE.ASSIGN_TASK_DISPATCH,
    targetAgentId: "worker",
    sourceAgentId: "controller",
    deliveryTicketId: "DT-1",
  });
  assert.equal(withTicket.deliveryTicketId, "DT-1");
});

test("system_action_wake_agent requires sourceAgentId + actionType", () => {
  const envelope = buildRuntimeWakeEnvelope({
    semanticType: WAKE_SEMANTIC_TYPE.SYSTEM_ACTION_WAKE_AGENT,
    targetAgentId: "worker",
    sourceAgentId: "planner",
    actionType: "assign_task",
  });
  assert.equal(envelope.sourceAgentId, "planner");
  assert.equal(envelope.actionType, "assign_task");
});

test("terminal_delivery_ready requires deliveryId + contractId", () => {
  const envelope = buildRuntimeWakeEnvelope({
    semanticType: WAKE_SEMANTIC_TYPE.TERMINAL_DELIVERY_READY,
    targetAgentId: "controller",
    deliveryId: "DL-1",
    contractId: "TC-7",
  });
  assert.equal(envelope.deliveryId, "DL-1");
  assert.equal(envelope.contractId, "TC-7");
});

test("heartbeat_poll and generic need only base shape", () => {
  for (const type of [WAKE_SEMANTIC_TYPE.HEARTBEAT_POLL, WAKE_SEMANTIC_TYPE.GENERIC]) {
    const envelope = buildRuntimeWakeEnvelope({
      semanticType: type,
      targetAgentId: "worker",
    });
    assert.equal(envelope.semanticType, type);
    assert.equal(envelope.targetAgentId, "worker");
  }
});

test("listRequiredFieldsForSemantic and isKnownWakeSemanticType agree with schema", () => {
  assert.deepEqual(listRequiredFieldsForSemantic(WAKE_SEMANTIC_TYPE.EXECUTION_CONTRACT), ["contractId"]);
  assert.deepEqual(listRequiredFieldsForSemantic(WAKE_SEMANTIC_TYPE.REQUEST_REVIEW_DISPATCH).sort(),
    ["deliveryTicketId", "sourceAgentId"]);
  assert.equal(isKnownWakeSemanticType(WAKE_SEMANTIC_TYPE.GENERIC), true);
  assert.equal(isKnownWakeSemanticType("unknown_type"), false);
});

test("validateWakeEnvelope rejects wrong version", () => {
  const envelope = {
    version: 99,
    semanticType: WAKE_SEMANTIC_TYPE.GENERIC,
    targetAgentId: "worker",
    createdAt: Date.now(),
    renderText: "",
  };
  assert.equal(validateWakeEnvelope(envelope).ok, false);
});

test("renderWakeEnvelopeToText prefers envelope.renderText, falls back to built reason", () => {
  const withRender = {
    version: WAKE_ENVELOPE_VERSION,
    semanticType: WAKE_SEMANTIC_TYPE.GENERIC,
    targetAgentId: "worker",
    createdAt: Date.now(),
    renderText: "explicit render",
  };
  assert.equal(renderWakeEnvelopeToText(withRender), "explicit render");
  const envelope = normalizeWakeEnvelope({
    version: WAKE_ENVELOPE_VERSION,
    semanticType: WAKE_SEMANTIC_TYPE.EXECUTION_CONTRACT,
    targetAgentId: "worker",
    createdAt: Date.now(),
    contractId: "TC-9",
  });
  const rendered = renderWakeEnvelopeToText(envelope);
  assert.equal(rendered, "继续处理当前任务。");
});

test("runtime wake blocks control-plane operator from ordinary task runtime", async () => {
  let heartbeatRequested = false;
  const wake = await runtimeWakeAgentDetailed(
    "operator",
    null,
    {
      runtime: {
        system: {
          requestHeartbeatNow() {
            heartbeatRequested = true;
          },
        },
      },
    },
    { info() {}, warn() {}, error() {} },
    {
      wakeSemantic: WAKE_SEMANTIC_TYPE.GENERIC,
    },
  );

  assert.equal(wake.ok, false);
  assert.equal(wake.requested, false);
  assert.equal(wake.reason, "control_plane_activation_blocked");
  assert.equal(heartbeatRequested, false);
});
