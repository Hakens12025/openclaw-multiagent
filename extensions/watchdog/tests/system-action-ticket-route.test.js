import test from "node:test";
import assert from "node:assert/strict";

import {
  clearSystemActionDeliveryTicketStore,
  registerSystemActionDeliveryTicket,
  resolveSystemActionDeliveryTicketRoute,
} from "../lib/routing/delivery/delivery-system-action-ticket.js";
import {
  clearAllPendingSignals,
  hasPendingSignal,
} from "../lib/runtime/pending-signal-registry.js";
import { runtimeAgentConfigs } from "../lib/state.js";

let runtimeAgentConfigSnapshot;

test.beforeEach(() => {
  runtimeAgentConfigSnapshot = new Map(runtimeAgentConfigs);
  runtimeAgentConfigs.set("worker-a", {
    id: "worker-a",
    role: "executor",
    plane: "runtime",
    mainViewVisible: true,
    formalTimelineVisible: true,
    autoWakeEligible: true,
  });
  clearAllPendingSignals();
});

test.afterEach(() => {
  clearAllPendingSignals();
  runtimeAgentConfigs.clear();
  for (const [agentId, config] of runtimeAgentConfigSnapshot.entries()) {
    runtimeAgentConfigs.set(agentId, config);
  }
});

test("system action delivery rejects missing ticket refs instead of fallback routing", async () => {
  await clearSystemActionDeliveryTicketStore();

  const route = await resolveSystemActionDeliveryTicketRoute({
    systemActionDeliveryTicket: { id: `SADT-missing-${Date.now()}` },
    replyTo: {
      agentId: "controller",
      sessionKey: "agent:controller:main",
    },
  });

  assert.equal(route.ok, false);
  assert.equal(route.resolvedBy, "ticket_missing");
  assert.equal(route.error, "missing_delivery_ticket");
  assert.equal(route.targetAgent, null);
});

test("system action delivery rejects ticketless routes instead of fallback routing", async () => {
  await clearSystemActionDeliveryTicketStore();

  const route = await resolveSystemActionDeliveryTicketRoute({
    replyTo: {
      agentId: "controller",
      sessionKey: "agent:controller:main",
    },
  });

  assert.equal(route.ok, false);
  assert.equal(route.resolvedBy, "missing_ticket");
  assert.equal(route.error, "missing_delivery_ticket");
  assert.equal(route.targetAgent, null);
});

test("system action delivery resolves only registered tickets", async () => {
  await clearSystemActionDeliveryTicketStore();

  const ticket = await registerSystemActionDeliveryTicket({
    lane: "delivery:system_action_runtime_result",
    intentType: "create_task",
    sourceAgentId: "worker-a",
    sourceSessionKey: "agent:worker-a:main",
    sourceContractId: "TC-ticket-source",
    replyTo: {
      agentId: "worker-a",
      sessionKey: "agent:worker-a:main",
    },
    upstreamReplyTo: {
      agentId: "controller",
      sessionKey: "agent:controller:main",
    },
  });

  const route = await resolveSystemActionDeliveryTicketRoute({
    systemActionDeliveryTicket: ticket,
  });

  assert.equal(route.ok, true);
  assert.equal(route.resolvedBy, "ticket");
  assert.equal(route.ticketId, ticket.id);
  assert.equal(route.targetAgent, "worker-a");
  assert.equal(route.targetSessionKey, "agent:worker-a:main");
});

test("clearing system action delivery tickets also clears their pending signals", async () => {
  await clearSystemActionDeliveryTicketStore();

  await registerSystemActionDeliveryTicket({
    lane: "delivery:system_action_runtime_result",
    intentType: "create_task",
    sourceAgentId: "worker-a",
    sourceSessionKey: "agent:worker-a:main",
    sourceContractId: "TC-ticket-source",
    replyTo: {
      agentId: "worker-a",
      sessionKey: "agent:worker-a:main",
    },
  });

  assert.equal(hasPendingSignal("worker-a"), true);

  await clearSystemActionDeliveryTicketStore();

  assert.equal(hasPendingSignal("worker-a"), false);
});
