import test from "node:test";
import assert from "node:assert/strict";

import {
  WAKE_SEMANTIC_TYPE,
  buildRuntimeWakeEnvelope,
  isInternalWakeSemanticType,
} from "../lib/transport/runtime-wake-envelope.js";
import { createDirectRequestEnvelope, isDirectRequestEnvelope } from "../lib/protocol-primitives.js";
import { buildDirectServiceSession } from "../lib/service-session.js";

test("execution_contract vs direct_request_resume are distinct wake semantic types", () => {
  const exec = buildRuntimeWakeEnvelope({
    semanticType: WAKE_SEMANTIC_TYPE.EXECUTION_CONTRACT,
    targetAgentId: "worker-a",
    contractId: "TC-1",
  });
  const direct = buildRuntimeWakeEnvelope({
    semanticType: WAKE_SEMANTIC_TYPE.DIRECT_REQUEST_RESUME,
    targetAgentId: "worker-a",
    envelopeId: "env-1",
  });
  assert.notEqual(exec.semanticType, direct.semanticType);
  assert.equal(exec.contractId, "TC-1");
  assert.equal(direct.envelopeId, "env-1");
  assert.equal(exec.envelopeId, undefined);
  assert.equal(direct.contractId, undefined);
});

test("both semantic types are classified as internal wake (should not be treated as user input)", () => {
  assert.equal(isInternalWakeSemanticType(WAKE_SEMANTIC_TYPE.EXECUTION_CONTRACT), true);
  assert.equal(isInternalWakeSemanticType(WAKE_SEMANTIC_TYPE.DIRECT_REQUEST_RESUME), true);
});

test("direct_request envelope is the canonical inbox marker for direct-request sessions", () => {
  const envelope = createDirectRequestEnvelope({
    agentId: "worker-a",
    sessionKey: "agent:worker-a:main:hook:1",
    serviceSession: buildDirectServiceSession({
      agentId: "worker-a",
      sessionKey: "agent:worker-a:main:hook:1",
    }),
    message: "hello",
    outputDir: "/tmp/out",
  });
  assert.equal(isDirectRequestEnvelope(envelope), true);
});

test("execution_contract envelope (non-direct-request) is NOT classified as direct-request", () => {
  // Plain contract lacks the direct_request envelope marker
  const executionContract = {
    id: "TC-1",
    task: "do the thing",
    assignee: "worker-a",
    output: "/tmp/out/TC-1.md",
  };
  assert.equal(isDirectRequestEnvelope(executionContract), false);
});

test("session bootstrap can distinguish the two paths purely from envelope data (no text parsing)", () => {
  // This is a structural invariant check: session-bootstrap routes on
  // isDirectRequestEnvelope(contract) from the inbox, not on wake text.
  // That means the wake envelope drives the wake, but the contract envelope
  // drives the bind — both ends are typed, no string classification.
  const inboxContractDirect = createDirectRequestEnvelope({
    agentId: "worker-a",
    sessionKey: "agent:worker-a:main:hook:2",
    serviceSession: buildDirectServiceSession({
      agentId: "worker-a",
      sessionKey: "agent:worker-a:main:hook:2",
    }),
    message: "please do X",
    outputDir: "/tmp/out",
  });
  const inboxContractExecution = {
    id: "TC-bound",
    task: "shared-contract stage",
    assignee: "worker-a",
    output: "/tmp/out/TC-bound.md",
  };
  assert.equal(isDirectRequestEnvelope(inboxContractDirect), true);
  assert.equal(isDirectRequestEnvelope(inboxContractExecution), false);
});
