import test from "node:test";
import assert from "node:assert/strict";

import {
  ABSOLUTE_TIMEOUT_CAP_EXTRA_MS,
  DEFAULT_PROGRESS_LEASE_MS,
  DEFAULT_QUEUE_ALLOWANCE_MS,
  createTestTimeoutBudget,
} from "../lib/test-timeout-policy.js";

test("timeout budget uses the larger base window plus queue allowance", () => {
  const budget = createTestTimeoutBudget({
    startMs: 1_000,
    baseTimeoutMs: 120_000,
    groupTimeoutMs: 300_000,
    queuePosition: 2,
  });

  assert.equal(budget.baseWindowMs, 300_000);
  assert.equal(budget.queueAllowanceMs, DEFAULT_QUEUE_ALLOWANCE_MS * 2);
  assert.equal(budget.currentDeadlineMs, 421_000);
  assert.equal(budget.hardDeadlineMs, 421_000 + ABSOLUTE_TIMEOUT_CAP_EXTRA_MS);
  assert.equal(budget.remainingMs(1_000), 420_000);
});

test("timeout budget progress lease extends the soft deadline but never exceeds the hard cap", () => {
  const budget = createTestTimeoutBudget({
    startMs: 0,
    baseTimeoutMs: 120_000,
    queuePosition: 1,
    progressLeaseMs: DEFAULT_PROGRESS_LEASE_MS,
    absoluteCapExtraMs: 180_000,
  });

  assert.equal(budget.currentDeadlineMs, 180_000);
  budget.noteProgress(170_000);
  assert.equal(budget.currentDeadlineMs, 290_000);

  budget.noteProgress(500_000);
  assert.equal(budget.currentDeadlineMs, 360_000);
});

test("timeout budget expires against the current soft deadline when no progress arrives", () => {
  const budget = createTestTimeoutBudget({
    startMs: 5_000,
    baseTimeoutMs: 120_000,
  });

  assert.equal(budget.isExpired(124_999), false);
  assert.equal(budget.isExpired(125_000), true);
});
