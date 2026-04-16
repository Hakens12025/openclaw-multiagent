import test from "node:test";
import assert from "node:assert/strict";

import { EVENT_TYPE } from "../lib/core/event-types.js";

// --- Frozen ---

test("EVENT_TYPE is frozen", () => {
  assert.ok(Object.isFrozen(EVENT_TYPE));
});

// --- Value uniqueness ---

test("all values are unique (no duplicates)", () => {
  const values = Object.values(EVENT_TYPE);
  assert.equal(values.length, new Set(values).size);
});

// --- Naming convention ---

test("all values are lowercase snake_case strings", () => {
  for (const [key, value] of Object.entries(EVENT_TYPE)) {
    assert.equal(typeof value, "string", `${key} should be string`);
    assert.ok(
      /^[a-z][a-z0-9_]*$/.test(value),
      `${key}="${value}" should be snake_case`,
    );
  }
});

// --- Key count ---

test("has at least 50 event types", () => {
  const count = Object.keys(EVENT_TYPE).length;
  assert.ok(count >= 50, `expected >= 50 keys, got ${count}`);
});

// --- Critical keys exist ---

test("critical dispatch/routing keys exist", () => {
  assert.ok("INBOX_DISPATCH" in EVENT_TYPE);
  assert.ok("GRAPH_QUEUE" in EVENT_TYPE);
  assert.ok("DISPATCH_RUNTIME_STATE" in EVENT_TYPE);
  assert.equal("WORKER_RUNTIME_STATE" in EVENT_TYPE, false);
  assert.equal("POOL_UPDATE" in EVENT_TYPE, false);
  assert.equal("DRAFT_PROMOTED" in EVENT_TYPE, false);
  assert.equal("DRAFT_TIMEOUT" in EVENT_TYPE, false);
});

test("critical delivery keys exist", () => {
  assert.ok("DELIVERY_CREATED" in EVENT_TYPE);
  assert.ok("DELIVERY_NOTIFIED" in EVENT_TYPE);
  assert.ok("DELIVERY_SKIPPED" in EVENT_TYPE);
  assert.ok("DELIVERY_WRITE_FAILED" in EVENT_TYPE);
});

test("critical loop keys exist and pipeline aliases are retired", () => {
  assert.ok("LOOP_STARTED" in EVENT_TYPE);
  assert.ok("LOOP_ADVANCED" in EVENT_TYPE);
  assert.ok("LOOP_CONCLUDED" in EVENT_TYPE);
  assert.ok("LOOP_INTERRUPTED" in EVENT_TYPE);
  assert.ok("LOOP_RESUMED" in EVENT_TYPE);
  assert.equal("PIPELINE_STARTED" in EVENT_TYPE, false);
  assert.equal("PIPELINE_ADVANCED" in EVENT_TYPE, false);
  assert.equal("PIPELINE_CONCLUDED" in EVENT_TYPE, false);
  assert.equal("PIPELINE_INTERRUPTED" in EVENT_TYPE, false);
  assert.equal("PIPELINE_RESUMED" in EVENT_TYPE, false);
});

test("critical error keys exist", () => {
  assert.ok("ERROR" in EVENT_TYPE);
  assert.ok("LOOP_WARNING" in EVENT_TYPE);
  assert.ok("LOOP_DETECTED" in EVENT_TYPE);
});

test("critical system/graph keys exist", () => {
  assert.ok("SYSTEM_RESET" in EVENT_TYPE);
  assert.ok("GRAPH_UPDATED" in EVENT_TYPE);
  assert.ok("DIRECT_SESSION" in EVENT_TYPE);
});

// --- Immutability ---

test("cannot add new properties", () => {
  assert.throws(() => {
    "use strict";
    EVENT_TYPE.NEW_KEY = "new_key";
  });
});

test("cannot modify existing properties", () => {
  assert.throws(() => {
    "use strict";
    EVENT_TYPE.ERROR = "changed";
  });
});
