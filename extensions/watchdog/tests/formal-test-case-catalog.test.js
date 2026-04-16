import test from "node:test";
import assert from "node:assert/strict";

import {
  FORMAL_CONCURRENT_CASES,
  FORMAL_SINGLE_CASES,
  getFormalSingleCaseById,
} from "../lib/formal-test-case-catalog.js";

test("formal single case catalog keeps canonical case ids in order", () => {
  assert.deepEqual(
    FORMAL_SINGLE_CASES.map((entry) => entry.id),
    ["simple-01", "simple-02", "simple-03", "complex-01", "complex-02", "complex-03"],
  );
});

test("formal complex cases use extended timeout windows for heavier tasks", () => {
  assert.equal(getFormalSingleCaseById("simple-03")?.timeoutMs, 120000);
  assert.equal(getFormalSingleCaseById("complex-01")?.timeoutMs, 300000);
  assert.equal(getFormalSingleCaseById("complex-02")?.timeoutMs, 300000);
  assert.equal(getFormalSingleCaseById("complex-03")?.timeoutMs, 300000);
});

test("formal concurrent case catalog keeps canonical group ids in order", () => {
  assert.deepEqual(
    FORMAL_CONCURRENT_CASES.map((entry) => entry.id),
    ["conc-formal-3", "conc-same-3", "conc-2s", "conc-1s1c", "conc-3m", "conc-4s-queue"],
  );
});
