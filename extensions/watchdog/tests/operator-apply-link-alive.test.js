import test, { mock } from "node:test";
import assert from "node:assert/strict";

import {
  executeAdminSurfaceOperation as realExecuteAdminSurfaceOperation,
  getAdminSurfaceOperationHandler,
  hasAdminSurfaceOperationHandler,
} from "../lib/admin/admin-surface-operations.js";

// P2.5 end-to-end proof: an operatorExecutable:true admin apply surface passes
// all four executor gates (actor===operator / operatorExecutable===true /
// executable===true / source===admin_surface) and is delegated to
// executeAdminSurfaceOperation. We mock ONLY the apply sink so the proof stays
// fully isolated from runtime truth — we never mutate a real agent/loop. The
// real hasAdminSurfaceOperationHandler / getAdminSurfaceOperationHandler are
// preserved so the registry's `executable` flag is still derived for real.
const sinkCalls = [];
mock.module("../lib/admin/admin-surface-operations.js", {
  namedExports: {
    hasAdminSurfaceOperationHandler,
    getAdminSurfaceOperationHandler,
    executeAdminSurfaceOperation: async (args) => {
      sinkCalls.push(args);
      return { ok: true, mocked: true, surfaceId: args?.surfaceId };
    },
  },
});

// Imported AFTER the mock so the executor binds the mocked sink.
const { executeCliSystemSurface, getCliSystemSurface } = await import(
  "../lib/cli-system/cli-surface-registry.js"
);

// agents.policy: operatorExecutable:true, risk=safe, status=active, source=admin_surface.
const PROOF_SURFACE_ID = "agents.policy";

test("apply link alive: chosen proof surface satisfies all four gate preconditions", () => {
  const surface = getCliSystemSurface(PROOF_SURFACE_ID);
  assert.ok(surface, "proof surface must resolve in the merged catalog");
  assert.equal(surface.family, "apply", "gate basis: it is an apply surface");
  assert.equal(surface.operatorExecutable, true, "gate 2: operatorExecutable===true");
  assert.equal(surface.executable, true, "gate 3: executable===true (handler present)");
  assert.equal(surface.source, "admin_surface", "gate 4: source===admin_surface");
});

test("apply link alive: operator passes all four gates and reaches the admin executor sink", async () => {
  sinkCalls.length = 0;
  const payload = { agentId: "proof-agent", policy: { autonomyLevel: "low" } };

  const result = await executeCliSystemSurface({
    surfaceId: PROOF_SURFACE_ID,
    payload,
    actor: "operator",
  });

  // executeAdminSurfaceOperation was actually reached -> all four gates passed.
  assert.equal(sinkCalls.length, 1, "executor must delegate exactly once to the admin sink");
  assert.equal(sinkCalls[0].surfaceId, PROOF_SURFACE_ID);
  assert.deepEqual(sinkCalls[0].payload, payload, "payload is forwarded intact to the sink");

  // executeCliSystemSurface returns the sink result (successful return).
  assert.equal(result.ok, true);
  assert.equal(result.mocked, true);
  assert.equal(result.surfaceId, PROOF_SURFACE_ID);
});

test("apply link alive: real executeAdminSurfaceOperation export still exists (sink is real, only test-mocked)", () => {
  // Guards against the proof becoming vacuous: the production sink must be a
  // real async function in the unmocked module.
  assert.equal(typeof realExecuteAdminSurfaceOperation, "function");
});
