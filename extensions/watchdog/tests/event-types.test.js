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

// 下限随真值走:回路运行时退役删掉 LOOP_STARTED 后为 49(2026-08-18);
// 评审链退役再删 CODE_REVIEW_REQUESTED / SYSTEM_ACTION_REVIEW_VERDICT_DELIVERED(2026-08-22)。
test("has at least 46 event types", () => {
  const count = Object.keys(EVENT_TYPE).length;
  assert.ok(count >= 46, `expected >= 46 keys, got ${count}`);
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

test("loop runtime event keys are retired and pipeline aliases never revive", () => {
  // 回路运行时退役(2026-08-18):loop_started 也没有广播点了,整族常量清空。
  // 2026-08-19 命名收口:执行硬停那台机器的 LOOP_WARNING 已改名
  // EXECUTION_HARD_STOP_WARNING、死常量 LOOP_DETECTED 已删 —— loop 一词
  // 在 EVENT_TYPE 里不再承担任何功能,故整族键名一并钉死为不得复活。
  assert.equal("LOOP_STARTED" in EVENT_TYPE, false);
  assert.equal("LOOP_ADVANCED" in EVENT_TYPE, false);
  assert.equal("LOOP_CONCLUDED" in EVENT_TYPE, false);
  assert.equal("LOOP_INTERRUPTED" in EVENT_TYPE, false);
  assert.equal("LOOP_RESUMED" in EVENT_TYPE, false);
  assert.equal("PIPELINE_STARTED" in EVENT_TYPE, false);
  assert.equal("PIPELINE_ADVANCED" in EVENT_TYPE, false);
  assert.equal("PIPELINE_CONCLUDED" in EVENT_TYPE, false);
  assert.equal("PIPELINE_INTERRUPTED" in EVENT_TYPE, false);
  assert.equal("PIPELINE_RESUMED" in EVENT_TYPE, false);
  assert.equal("LOOP_WARNING" in EVENT_TYPE, false);
  assert.equal("LOOP_DETECTED" in EVENT_TYPE, false);
  assert.ok(
    Object.keys(EVENT_TYPE).every((key) => !key.startsWith("LOOP_")),
    "EVENT_TYPE 不得再出现任何 LOOP_ 前缀键",
  );
});

test("critical error keys exist", () => {
  assert.ok("ERROR" in EVENT_TYPE);
  assert.ok("EXECUTION_HARD_STOP_WARNING" in EVENT_TYPE);
});

test("critical system/graph keys exist", () => {
  assert.ok("SYSTEM_RESET" in EVENT_TYPE);
  assert.ok("GRAPH_UPDATED" in EVENT_TYPE);
  assert.ok("DIRECT_INTAKE_BLOCKED" in EVENT_TYPE);
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
