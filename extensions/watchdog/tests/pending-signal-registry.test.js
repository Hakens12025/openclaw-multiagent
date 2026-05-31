import test from "node:test";
import assert from "node:assert/strict";

import {
  PENDING_SIGNAL_KINDS,
  registerPendingSignal,
  clearPendingSignal,
  hasPendingSignal,
  listPendingSignals,
  summarizePendingSignalRegistry,
  prunePendingSignals,
  clearAllPendingSignals,
} from "../lib/runtime/pending-signal-registry.js";
import { registerRuntimeAgents } from "../lib/agent/agent-identity.js";
import { runtimeAgentConfigs } from "../lib/state.js";

test.beforeEach(() => {
  runtimeAgentConfigs.clear();
  registerRuntimeAgents({
    agents: {
      list: [
        { id: "controller", role: "bridge", gateway: true },
        { id: "worker", role: "executor" },
      ],
    },
  });
  clearAllPendingSignals();
});

test.afterEach(() => {
  runtimeAgentConfigs.clear();
});

test("register + hasPendingSignal round trip", () => {
  registerPendingSignal({
    agentId: "controller",
    sourceKind: PENDING_SIGNAL_KINDS.CHANNEL_INGRESS_WEBUI,
    sourceRef: "msg-1",
  });
  assert.equal(hasPendingSignal("controller"), true);
  assert.equal(hasPendingSignal("other"), false);
});

test("clearPendingSignal removes the matching entry and keeps others", () => {
  registerPendingSignal({
    agentId: "controller",
    sourceKind: PENDING_SIGNAL_KINDS.RUNTIME_DIRECT_ENVELOPE,
    sourceRef: "env-1",
    envelopeId: "env-1",
  });
  registerPendingSignal({
    agentId: "controller",
    sourceKind: PENDING_SIGNAL_KINDS.SYSTEM_ACTION_DELIVERY,
    sourceRef: "ticket-1",
  });
  assert.equal(hasPendingSignal("controller"), true);
  clearPendingSignal({
    agentId: "controller",
    sourceKind: PENDING_SIGNAL_KINDS.RUNTIME_DIRECT_ENVELOPE,
    envelopeId: "env-1",
  });
  const remaining = listPendingSignals("controller");
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].sourceKind, PENDING_SIGNAL_KINDS.SYSTEM_ACTION_DELIVERY);
});

test("channel_ingress signals expire after TTL but durable sources persist", () => {
  const now = 1_000_000;
  registerPendingSignal({
    agentId: "controller",
    sourceKind: PENDING_SIGNAL_KINDS.CHANNEL_INGRESS_WEBUI,
    sourceRef: "msg-ttl",
    now,
  });
  registerPendingSignal({
    agentId: "controller",
    sourceKind: PENDING_SIGNAL_KINDS.RUNTIME_DIRECT_ENVELOPE,
    sourceRef: "env-durable",
    envelopeId: "env-durable",
    now,
  });
  const later = now + 20 * 60 * 1000; // 20 minutes past TTL default
  assert.equal(hasPendingSignal("controller", { now: later }), true, "durable envelope keeps signal alive");
  const live = listPendingSignals("controller", { now: later });
  assert.equal(live.length, 1);
  assert.equal(live[0].sourceKind, PENDING_SIGNAL_KINDS.RUNTIME_DIRECT_ENVELOPE);
});

test("summary reports active/stale counts + source coverage", () => {
  const now = 1_000_000;
  registerPendingSignal({
    agentId: "controller",
    sourceKind: PENDING_SIGNAL_KINDS.CHANNEL_INGRESS_WEBUI,
    sourceRef: "msg-a",
    now,
  });
  registerPendingSignal({
    agentId: "worker",
    sourceKind: PENDING_SIGNAL_KINDS.RUNTIME_DIRECT_ENVELOPE,
    sourceRef: "env",
    envelopeId: "env",
    now,
  });
  const summary = summarizePendingSignalRegistry({ now });
  assert.equal(summary.activeSignals, 2);
  assert.equal(summary.staleSignals, 0);
  assert.equal(summary.sourceCoverage[PENDING_SIGNAL_KINDS.CHANNEL_INGRESS_WEBUI], 1);
  assert.equal(summary.sourceCoverage[PENDING_SIGNAL_KINDS.RUNTIME_DIRECT_ENVELOPE], 1);
});

test("prune removes expired entries but leaves durable ones", () => {
  const now = 1_000_000;
  registerPendingSignal({
    agentId: "controller",
    sourceKind: PENDING_SIGNAL_KINDS.CHANNEL_INGRESS_TEST_INJECT,
    sourceRef: "tick",
    now,
  });
  registerPendingSignal({
    agentId: "controller",
    sourceKind: PENDING_SIGNAL_KINDS.SYSTEM_ACTION_DELIVERY,
    sourceRef: "ticket",
    now,
  });
  const later = now + 20 * 60 * 1000;
  const removed = prunePendingSignals({ now: later });
  assert.equal(removed, 1);
  const remaining = listPendingSignals("controller", { now: later });
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].sourceKind, PENDING_SIGNAL_KINDS.SYSTEM_ACTION_DELIVERY);
});
