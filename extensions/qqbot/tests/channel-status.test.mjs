import test from "node:test";
import assert from "node:assert/strict";

import { qqbotPlugin } from "../dist/src/channel.js";

test("qqbot gateway marks a resumed session as connected", () => {
  const updates = [];
  const ctx = {
    getStatus: () => ({ running: true, connected: false, lastConnectedAt: null, lastError: "stale-socket" }),
    setStatus: (status) => updates.push(status),
  };

  qqbotPlugin.gateway.applyConnectedStatus(ctx, {
    accountId: "default",
    eventType: "RESUMED",
    now: 12345,
  });

  assert.equal(updates.length, 1);
  assert.equal(updates[0].running, true);
  assert.equal(updates[0].connected, true);
  assert.equal(updates[0].lastConnectedAt, 12345);
  assert.equal(updates[0].lastError, null);
  assert.equal(updates[0].lastConnectionEvent, "RESUMED");
});
