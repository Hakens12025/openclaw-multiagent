import test from "node:test";
import assert from "node:assert/strict";

import { resolveSystemActionDeliveryTicketRoute } from "../lib/routing/delivery-system-action-ticket.js";

test("system action delivery ticket route fallback naming is canonical when ticket is missing", async () => {
  const route = await resolveSystemActionDeliveryTicketRoute({
    systemActionDeliveryTicket: { id: `SADT-missing-${Date.now()}` },
    replyTo: {
      agentId: "controller",
      sessionKey: "agent:controller:main",
    },
  });

  assert.equal(route.resolvedBy, "fallback_ticket_missing");
});

test("system action delivery ticket route fallback naming is canonical without a ticket", async () => {
  const route = await resolveSystemActionDeliveryTicketRoute({
    replyTo: {
      agentId: "controller",
      sessionKey: "agent:controller:main",
    },
  });

  assert.equal(route.resolvedBy, "fallback_direct");
});
