import test, { mock } from "node:test";
import assert from "node:assert/strict";

// E1 — operator multi-step apply is atomic: capture a structure snapshot before the first mutation,
// and on a mid-plan throw roll back + return a STRUCTURED failure (not a bare throw → opaque 400).
// Isolation mirrors operator-force-verify-after-apply.test.js: mock the terminal sink (so no real
// mutation/test runs), the graph inspector, and the snapshot mechanism; keep the real registry so
// the feasibility pre-flight + cli-surface-executor gates run. Needs --experimental-test-module-mocks.

import {
  getAdminSurfaceOperationHandler,
  hasAdminSurfaceOperationHandler,
} from "../lib/admin/operations/admin-surface-operations.js";
// Keep the real sibling exports (projectStructureAfter etc. are imported by other modules in the
// executor's dependency graph) — we only override capture/restore. mock.module replaces ALL exports.
import * as realSnapshot from "../lib/control-plane/structure-snapshot.js";

let callCount = 0;
let throwOnCall = 0; // 1-based index of the executeAdminSurfaceOperation call that throws (0 = never)
mock.module("../lib/admin/operations/admin-surface-operations.js", {
  namedExports: {
    hasAdminSurfaceOperationHandler,
    getAdminSurfaceOperationHandler,
    executeAdminSurfaceOperation: async ({ surfaceId }) => {
      callCount += 1;
      if (throwOnCall > 0 && callCount === throwOnCall) throw new Error(`boom on call ${callCount} (${surfaceId})`);
      return { ok: true, applied: true };
    },
  },
});

mock.module("../lib/cli-system/cli-graph-inspector.js", {
  namedExports: { inspectCliSystemGraphState: async () => ({ edges: [] }) },
});

let captureCalls = 0;
mock.module("../lib/control-plane/structure-snapshot.js", {
  namedExports: {
    ...realSnapshot,
    captureStructureSnapshot: async () => { captureCalls += 1; return { id: "SNAP-test-1" }; },
    restoreStructureSnapshot: async (id) => ({ ok: true, id, restored: { graph: true } }),
  },
});

const { executeOperatorExecutablePlan } = await import("../lib/operator/operator-executor.js");

// graph.edge.add is risk:safe/changeset (C2 doesn't block) + verify-exempt. Use REAL core agents so
// the feasibility pre-flight passes (planner/worker/worker2 are stable live agents).
const edge = (from, to) => ({ surfaceId: "graph.edge.add", title: "e", summary: "e", payload: { from, to } });

test("E1: mid-plan throw rolls back + returns ok:false with failedStepIndex (no throw)", async () => {
  callCount = 0; throwOnCall = 3; captureCalls = 0;
  const out = await executeOperatorExecutablePlan({
    plan: {
      intent: "platform_mutation", summary: "3-edge",
      steps: [edge("planner", "worker"), edge("worker", "worker2"), edge("worker2", "planner")],
    },
  });
  assert.equal(out.ok, false);
  assert.equal(out.failedStepIndex, 2);
  assert.equal(out.failedSurfaceId, "graph.edge.add");
  assert.equal(out.appliedResults.length, 2, "two steps applied before the throw");
  assert.equal(out.rollback.ok, true);
  assert.equal(out.rollback.id, "SNAP-test-1");
  assert.match(out.error, /boom/);
  assert.equal(captureCalls, 1, "multi-step plan captures exactly one pre-apply snapshot");
});

test("E1: all-steps-succeed → ok:true, no failedStepIndex / rollback", async () => {
  callCount = 0; throwOnCall = 0;
  const out = await executeOperatorExecutablePlan({
    plan: { intent: "platform_mutation", summary: "2-edge", steps: [edge("planner", "worker"), edge("worker", "worker2")] },
  });
  assert.equal(out.ok, true);
  assert.equal(out.results.length, 2);
  assert.ok(!("failedStepIndex" in out));
  assert.ok(!("rollback" in out));
});

test("E1: single-step throw → capture GATED off (no snapshot), rollback is a no-op", async () => {
  callCount = 0; throwOnCall = 1; captureCalls = 0;
  const out = await executeOperatorExecutablePlan({
    plan: { intent: "platform_mutation", summary: "1-edge", steps: [edge("planner", "worker")] },
  });
  assert.equal(out.ok, false);
  assert.equal(out.failedStepIndex, 0);
  assert.equal(out.appliedResults.length, 0);
  assert.equal(captureCalls, 0, "single-step plan skips the snapshot capture (can't half-apply)");
  assert.equal(out.rollback.ok, false);
  assert.match(out.rollback.error, /no pre-apply snapshot/);
});
