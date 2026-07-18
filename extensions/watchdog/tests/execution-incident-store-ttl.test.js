import test from "node:test";
import assert from "node:assert/strict";

import {
  INCIDENT_TTL_MS,
  MAX_INCIDENTS,
  clearAllExecutionIncidents,
  getExecutionIncident,
  listExecutionIncidents,
  pruneExecutionIncidents,
  upsertExecutionIncident,
} from "../lib/runtime/execution-incident-store.js";

test.beforeEach(() => {
  clearAllExecutionIncidents();
});

test("incident expires from reads once idle past INCIDENT_TTL_MS", () => {
  const now = 1_000_000;
  upsertExecutionIncident(
    { contractId: "TC-ttl-1", agentId: "worker", rootFault: "llm_fault" },
    { now },
  );

  const nearEdge = now + INCIDENT_TTL_MS - 1;
  assert.equal(
    getExecutionIncident({ contractId: "TC-ttl-1" }, { now: nearEdge })?.contractId,
    "TC-ttl-1",
  );
  assert.equal(listExecutionIncidents({ now: nearEdge }).length, 1);

  const expired = now + INCIDENT_TTL_MS;
  assert.equal(getExecutionIncident({ contractId: "TC-ttl-1" }, { now: expired }), null);
  assert.equal(listExecutionIncidents({ now: expired }).length, 0);
});

test("a later amplification refreshes updatedAt and postpones expiry", () => {
  const now = 1_000_000;
  upsertExecutionIncident(
    { contractId: "TC-ttl-refresh", agentId: "worker", rootFault: "llm_fault" },
    { now },
  );

  const bump = now + 20 * 60 * 1000; // amplify 20 min later
  upsertExecutionIncident(
    { contractId: "TC-ttl-refresh", amplifiers: ["wrong_actor_activation"] },
    { now: bump },
  );

  // 25 min after creation (5 min after refresh) -> still alive
  const probe = now + 25 * 60 * 1000;
  assert.equal(
    getExecutionIncident({ contractId: "TC-ttl-refresh" }, { now: probe })?.contractId,
    "TC-ttl-refresh",
  );

  // dies TTL after the refresh, not TTL after creation
  const afterRefreshTtl = bump + INCIDENT_TTL_MS;
  assert.equal(getExecutionIncident({ contractId: "TC-ttl-refresh" }, { now: afterRefreshTtl }), null);
});

test("pruneExecutionIncidents reaps idle entries and reports the count", () => {
  const now = 1_000_000;
  upsertExecutionIncident({ contractId: "TC-a", agentId: "w", rootFault: "llm_fault" }, { now });
  upsertExecutionIncident({ contractId: "TC-b", agentId: "w", rootFault: "llm_fault" }, { now });

  const removed = pruneExecutionIncidents({ now: now + INCIDENT_TTL_MS });
  assert.equal(removed, 2);
  assert.equal(listExecutionIncidents({ now: now + INCIDENT_TTL_MS }).length, 0);
});

test("upsert self-prunes idle entries on write (no external pruner needed)", () => {
  const now = 1_000_000;
  upsertExecutionIncident({ contractId: "TC-stale", agentId: "w", rootFault: "llm_fault" }, { now });

  // fresh write TTL later must evict TC-stale as a side effect of the sweep
  upsertExecutionIncident(
    { contractId: "TC-live", agentId: "w", rootFault: "llm_fault" },
    { now: now + INCIDENT_TTL_MS },
  );

  const live = listExecutionIncidents({ now: now + INCIDENT_TTL_MS });
  assert.equal(live.length, 1);
  assert.equal(live[0].contractId, "TC-live");
});

// FIX(A6-incident-ttl/review): a new fault reusing an expired incident's key must start
// FRESH, never inherit the dead incident's createdAt / firstFaultCode / pinned rootFault /
// amplifiers (the read paths already treat it as dead, so the merge path must too).
test("upsert on an expired key starts a fresh incident, not a resurrection", () => {
  const t0 = 1_000_000;
  upsertExecutionIncident(
    { contractId: "c1", rootFault: "system_fault", firstFaultCode: "max_tool_calls", amplifiers: ["a1"] },
    { now: t0 },
  );

  const t1 = t0 + INCIDENT_TTL_MS; // c1 is now idle-expired
  assert.equal(getExecutionIncident({ contractId: "c1" }, { now: t1 }), null, "read path sees it as dead");

  const fresh = upsertExecutionIncident(
    { contractId: "c1", rootFault: "tool_failure", firstFaultCode: "identical_tool_loop" },
    { now: t1 },
  );
  assert.equal(fresh.rootFault, "tool_failure", "must NOT pin the stale system_fault");
  assert.equal(fresh.firstFaultCode, "identical_tool_loop", "must NOT inherit stale firstFaultCode");
  assert.equal(fresh.createdAt, t1, "must NOT claim the 30-min-old createdAt");
  assert.deepEqual(fresh.amplifiers, [], "must NOT resurrect stale amplifiers");
});

test("MAX_INCIDENTS cap evicts the least-recently-written incident (LRU)", () => {
  const base = 1_000_000;
  for (let i = 0; i < MAX_INCIDENTS; i += 1) {
    upsertExecutionIncident({ contractId: `TC-${i}`, agentId: "w", rootFault: "llm_fault" }, { now: base + i });
  }
  const readAt = base + MAX_INCIDENTS; // ages << TTL, so cap (not TTL) drives eviction
  assert.equal(listExecutionIncidents({ now: readAt }).length, MAX_INCIDENTS);

  upsertExecutionIncident({ contractId: "TC-overflow", agentId: "w", rootFault: "llm_fault" }, { now: readAt });
  assert.equal(listExecutionIncidents({ now: readAt }).length, MAX_INCIDENTS);
  assert.equal(getExecutionIncident({ contractId: "TC-0" }, { now: readAt }), null, "least-recently-written evicted");
  assert.equal(getExecutionIncident({ contractId: "TC-overflow" }, { now: readAt })?.contractId, "TC-overflow");
});

test("re-touching an incident protects it from LRU eviction", () => {
  const base = 1_000_000;
  for (let i = 0; i < MAX_INCIDENTS; i += 1) {
    upsertExecutionIncident({ contractId: `TC-${i}`, agentId: "w", rootFault: "llm_fault" }, { now: base + i });
  }

  // re-touch the oldest -> moves it to the tail (most recently written)
  upsertExecutionIncident({ contractId: "TC-0", amplifiers: ["x"] }, { now: base + MAX_INCIDENTS });

  // overflow -> TC-1 is now the oldest and gets evicted; TC-0 survives
  const readAt = base + MAX_INCIDENTS + 1;
  upsertExecutionIncident({ contractId: "TC-overflow", agentId: "w", rootFault: "llm_fault" }, { now: readAt });
  assert.equal(getExecutionIncident({ contractId: "TC-0" }, { now: readAt })?.contractId, "TC-0", "re-touched entry survives");
  assert.equal(getExecutionIncident({ contractId: "TC-1" }, { now: readAt }), null, "new oldest evicted");
});
