import test from "node:test";
import assert from "node:assert/strict";

import { normalizeVerificationStatus } from "../lib/admin/change-sets/admin-change-set-history.js";

test("test-run finalizing status remains a running verification state", () => {
  const record = {
    status: "finalizing",
    totalCases: 1,
    completedCases: 1,
    passedCases: 1,
    failedCases: 0,
    blockedCases: 0,
  };

  assert.equal(normalizeVerificationStatus(record), "running");
});

test("test-run cleaning status remains a running verification state", () => {
  const record = {
    status: "cleaning",
    totalCases: 1,
    completedCases: 1,
    passedCases: 1,
    failedCases: 0,
    blockedCases: 0,
  };

  assert.equal(normalizeVerificationStatus(record), "running");
});
