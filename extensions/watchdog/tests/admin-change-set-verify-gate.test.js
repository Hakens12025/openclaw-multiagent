import test, { mock } from "node:test";
import assert from "node:assert/strict";

import {
  CommitVerificationBlockedError,
  evaluateCommitVerificationGate,
  isVerificationRequiredForCommit,
} from "../lib/admin/change-sets/admin-change-set-commit-gate.js";
import {
  getCliSystemSurface,
  listCliSystemSurfaces,
} from "../lib/cli-system/cli-surface-registry.js";

// ---------------------------------------------------------------------------
// P3 part 1: verify surfaces exposed as a formal verify family via the
// single cli-surface-registry (no second verify catalog).
// ---------------------------------------------------------------------------

test("verify surfaces exposed as verify family through the single registry", () => {
  const verify = listCliSystemSurfaces({ family: "verify" });
  assert.ok(verify.length >= 2, "expected >=2 verify-family surfaces");
  for (const surface of verify) {
    assert.equal(surface.family, "verify");
    assert.equal(surface.source, "admin_surface", "verify truth source is admin (single source)");
  }
});

test("operator can actively trigger executable verify surfaces (operatorExecutable + four-gate ready)", () => {
  const startRun = getCliSystemSurface("test_runs.start");
  assert.ok(startRun, "test_runs.start must resolve");
  assert.equal(startRun.family, "verify");
  assert.equal(startRun.operatorExecutable, true, "operator may actively trigger verify");
  assert.equal(startRun.executable, true);
  assert.equal(startRun.source, "admin_surface");

  // attach_verification has no handler -> stays non-executable (not a bypass).
  const attach = getCliSystemSurface("admin_change_sets.attach_verification");
  assert.equal(attach.operatorExecutable, false);
  assert.equal(attach.executable, false);
});

// ---------------------------------------------------------------------------
// P3 part 2 (pure gate logic): the four-question verify gate.
//   验什么 = verificationCapability ; 成功标准 = lastVerificationStatus==="passed"
//   证据 / 失败归因 = verificationHistory[].failedCaseIds / blockedCaseIds
// ---------------------------------------------------------------------------

test("gate is required only when verificationCapability.supported and requireVerification", () => {
  assert.equal(
    isVerificationRequiredForCommit({ preview: { verificationCapability: { supported: true } } }),
    true,
  );
  assert.equal(
    isVerificationRequiredForCommit({ preview: { verificationCapability: { supported: false } } }),
    false,
  );
  assert.equal(
    isVerificationRequiredForCommit({
      preview: { verificationCapability: { supported: true } },
      requireVerification: false,
    }),
    false,
  );
});

test("gate blocks commit when no passing verification on record (with failure attribution)", () => {
  const gate = evaluateCommitVerificationGate({
    preview: { verificationCapability: { supported: true } },
    draft: {
      lastVerificationStatus: "failed",
      verificationHistory: [{ failedCaseIds: ["case-A"], blockedCaseIds: [] }],
    },
  });
  assert.equal(gate.required, true);
  assert.equal(gate.passed, false, "gate must NOT pass without passing verification");
  assert.deepEqual(gate.failedCaseIds, ["case-A"], "failure attribution from existing field");
  assert.match(gate.reason, /not passed/);
});

test("gate blocks commit when verification is entirely missing", () => {
  const gate = evaluateCommitVerificationGate({
    preview: { verificationCapability: { supported: true } },
    draft: { lastVerificationStatus: null, verificationHistory: [] },
  });
  assert.equal(gate.passed, false);
  assert.equal(gate.lastVerificationStatus, "missing");
  assert.match(gate.reason, /no passing verification/);
});

test("gate allows commit when verification passed", () => {
  const gate = evaluateCommitVerificationGate({
    preview: { verificationCapability: { supported: true } },
    draft: { lastVerificationStatus: "passed", lastVerificationRunId: "TR-1" },
  });
  assert.equal(gate.required, true);
  assert.equal(gate.passed, true);
  assert.equal(gate.lastVerificationRunId, "TR-1");
});

test("gate is a no-op for surfaces that do not support verification", () => {
  const gate = evaluateCommitVerificationGate({
    preview: { verificationCapability: { supported: false } },
    draft: { lastVerificationStatus: null },
  });
  assert.equal(gate.required, false);
  assert.equal(gate.passed, true, "ungated surfaces commit normally");
});

// ---------------------------------------------------------------------------
// P3 part 2 (end-to-end hard path): the commit path actually refuses to record
// `applied` when the gate fails. We mock the dependencies so the proof is
// isolated from fs/gateway and assert the RECORDED status, not just a field.
// ---------------------------------------------------------------------------

const recordedExecutions = [];
const GATED_PREVIEW = {
  draftId: "TC-GATE",
  surfaceId: "agents.policy",
  supported: true,
  ready: true,
  confirmation: "changeset",
  payload: { agentId: "a1" },
  managementContext: {},
  request: {},
  verificationCapability: { supported: true },
};

mock.module("../lib/admin/change-sets/admin-change-set-preview.js", {
  namedExports: {
    buildAdminChangeSetPreview: () => GATED_PREVIEW,
    resolveAdminChangeSetVerificationRequest: () => null,
  },
});

mock.module("../lib/admin/operations/admin-surface-operations.js", {
  namedExports: {
    executeAdminSurfaceOperation: async () => ({ ok: true, applied: true }),
  },
});

// draftState lets each test set the draft's verification status the executor reads.
const draftState = { lastVerificationStatus: null, verificationHistory: [] };
mock.module("../lib/admin/change-sets/admin-change-sets.js", {
  namedExports: {
    getAdminChangeSetDetails: async () => ({
      id: "TC-GATE",
      surfaceId: "agents.policy",
      lastVerificationStatus: draftState.lastVerificationStatus,
      lastVerificationRunId: draftState.lastVerificationRunId || null,
      verificationHistory: draftState.verificationHistory,
    }),
    recordAdminChangeSetExecution: async (record) => {
      recordedExecutions.push(record);
      return {
        draft: { id: record.id, status: "recorded" },
        executionRecord: record,
      };
    },
  },
});

const { executeAdminChangeSet } = await import("../lib/admin/change-sets/admin-change-set-executor.js");

test("commit path HARD-BLOCKS: gate fail throws and never records applied", async () => {
  recordedExecutions.length = 0;
  draftState.lastVerificationStatus = "failed";
  draftState.verificationHistory = [{ failedCaseIds: ["x-1"], blockedCaseIds: [] }];

  await assert.rejects(
    () => executeAdminChangeSet({ id: "TC-GATE" }),
    (error) => {
      assert.ok(error instanceof CommitVerificationBlockedError, "must throw the gate error");
      return true;
    },
  );

  // The proof that matters: NOTHING was recorded as `applied`.
  assert.equal(recordedExecutions.length, 1, "exactly one execution record written");
  assert.equal(
    recordedExecutions[0].executionStatus,
    "verification_blocked",
    "blocked commit must be recorded as verification_blocked, NOT applied",
  );
  assert.notEqual(recordedExecutions[0].executionStatus, "applied");
});

test("commit path ALLOWS commit when a passing verification is on record", async () => {
  recordedExecutions.length = 0;
  draftState.lastVerificationStatus = "passed";
  draftState.lastVerificationRunId = "TR-OK";
  draftState.verificationHistory = [{ failedCaseIds: [], blockedCaseIds: [] }];

  const out = await executeAdminChangeSet({ id: "TC-GATE" });
  assert.equal(recordedExecutions.length, 1);
  assert.equal(
    recordedExecutions[0].executionStatus,
    "applied",
    "passing verification permits commit-to-applied",
  );
  assert.ok(out.result?.ok, "apply result returned on successful commit");
});

test("commit path is ungated when requireVerification=false (explicit opt-out path stays open)", async () => {
  recordedExecutions.length = 0;
  draftState.lastVerificationStatus = "failed";
  draftState.verificationHistory = [];

  const out = await executeAdminChangeSet({ id: "TC-GATE", requireVerification: false });
  assert.equal(recordedExecutions[0].executionStatus, "applied");
  assert.ok(out.result?.ok);
});
