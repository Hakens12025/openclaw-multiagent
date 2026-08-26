import test from "node:test";
import assert from "node:assert/strict";

import { evaluateProposalTier, dedupeKey, describeProposalEffect } from "../lib/control-plane/proposal-tier.js";
import { resolveDraftStatus } from "../lib/admin/change-sets/admin-change-set-history.js";

test("evaluateProposalTier maps risk/confirmation to tiers + gates", () => {
  const t4 = evaluateProposalTier({ risk: "destructive", confirmation: "explicit" });
  assert.equal(t4.tier, 4);
  assert.equal(t4.needsDoubleConfirm, true);
  assert.equal(t4.needsTypedAck, true);
  assert.equal(t4.autoSnapshotBeforeApply, true);

  const t3 = evaluateProposalTier({ risk: "structural", confirmation: "changeset" });
  assert.equal(t3.tier, 3);
  assert.equal(t3.needsDoubleConfirm, true);
  assert.equal(t3.needsTypedAck, false, "structural double-confirms but no typed ack");
  assert.equal(t3.autoSnapshotBeforeApply, true);

  const t2 = evaluateProposalTier({ risk: "safe", confirmation: "explicit" });
  assert.equal(t2.tier, 2);
  assert.equal(t2.needsDoubleConfirm, false);

  for (const r of ["read", "observe", "safe", "runtime_gate"]) {
    const t1 = evaluateProposalTier({ risk: r, confirmation: "none" });
    assert.equal(t1.tier, 1, `${r}/none → T1`);
    assert.equal(t1.autoSnapshotBeforeApply, false);
  }
});

test("dedupeKey is stable + key-order independent + distinguishes payloads", () => {
  const a = dedupeKey("graph.edge.add", { from: "x", to: "y" });
  const b = dedupeKey("graph.edge.add", { to: "y", from: "x" }); // different key order
  const c = dedupeKey("graph.edge.add", { from: "x", to: "z" });
  assert.equal(a, b, "key order must not change the fingerprint");
  assert.notEqual(a, c, "different payload → different key");
  assert.match(a, /^graph\.edge\.add:[0-9a-f]{12}$/);
});

test("describeProposalEffect gives human sentences + generic fallback", () => {
  assert.match(describeProposalEffect("graph.edge.add", { from: "researcher1", to: "reviewer1" }), /researcher1.*reviewer1/);
  assert.match(describeProposalEffect("graph.edge.delete", { from: "a", to: "b" }), /删除管线边/);
  assert.match(describeProposalEffect("agents.delete", { agentId: "worker-x" }), /删除.*worker-x/);
  assert.match(describeProposalEffect("some.unknown.surface", {}), /执行 some\.unknown\.surface/);
});

test("resolveDraftStatus surfaces reverted / revert_failed", () => {
  assert.equal(resolveDraftStatus({ lastExecutionStatus: "reverted" }), "reverted");
  assert.equal(resolveDraftStatus({ lastExecutionStatus: "revert_failed" }), "revert_failed");
  assert.equal(resolveDraftStatus({ lastExecutionStatus: "applied" }), "applied"); // unchanged
});
