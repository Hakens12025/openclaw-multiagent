import test from "node:test";
import assert from "node:assert/strict";

import {
  TRACE_EVENT_KINDS,
  TRACE_EVENT_CHANNELS,
  TRACE_EVENT_OUTCOMES,
  TRACE_SENTINELS,
  isLegalKindChannel,
  buildTraceEvent,
} from "../lib/evidence/trace-event-schema.js";

test("kind×channel legality matrix: internal only allows fc", () => {
  assert.equal(isLegalKindChannel("internal", "fc"), true);
  assert.equal(isLegalKindChannel("internal", "fence"), false);
  assert.equal(isLegalKindChannel("internal", "text"), false);
  assert.equal(isLegalKindChannel("collab", "fc"), true);
  assert.equal(isLegalKindChannel("collab", "fence"), true);
  assert.equal(isLegalKindChannel("collab", "text"), true);
});

test("buildTraceEvent rejects illegal combinations and unknown outcomes", () => {
  assert.throws(() => buildTraceEvent({
    kind: "internal", channel: "text", name: "write",
    outcome: "ok", sessionKey: "s",
  }), /illegal trace event/);
  assert.throws(() => buildTraceEvent({
    kind: "internal", channel: "fc", name: "write",
    outcome: "maybe", sessionKey: "s",
  }), /unknown trace outcome/);
});

test("buildTraceEvent produces a well-formed internal fc event", () => {
  const evt = buildTraceEvent({
    kind: TRACE_EVENT_KINDS.INTERNAL,
    channel: TRACE_EVENT_CHANNELS.FC,
    name: "write",
    argsDigest: { path: "/tmp/x.md", bytes: 12 },
    resultDigest: { bytes: 3 },
    outcome: TRACE_EVENT_OUTCOMES.OK,
    agentId: "worker",
    sessionKey: "agent:worker:c:TC-1",
    contractId: "TC-1",
  });
  assert.equal(evt.kind, "internal");
  assert.equal(evt.contractId, "TC-1");
  assert.ok(Number.isFinite(evt.ts));
  assert.equal(TRACE_SENTINELS.OPEN, "session_open");
});
