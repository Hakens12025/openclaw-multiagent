import test from "node:test";
import assert from "node:assert/strict";

import { executeOperatorExecutablePlan } from "../lib/operator/operator-executor.js";

// C2 — suggest-only boundary: operator must NOT auto-run an explicit-confirmation (destructive)
// surface without human confirm. The gate is pre-flight, so the destructive step never executes
// and no earlier step is half-applied. We only exercise the BLOCKED path (no side effects).

test("C2: explicit-confirm (destructive) step is refused without explicitConfirm; nothing applied", async () => {
  const plan = {
    intent: "platform_mutation",
    summary: "rebuild structure",
    steps: [
      { surfaceId: "agents.hard_delete", payload: { agentId: "no-such-operator-test-agent" }, title: "delete old" },
    ],
  };
  const result = await executeOperatorExecutablePlan({ plan, explicitConfirm: false });
  assert.equal(result.ok, false, "must be blocked");
  assert.equal(result.blocked, "explicit_confirmation_required");
  assert.ok(
    result.requiresExplicitConfirm.some((s) => s.surfaceId === "agents.hard_delete"),
    "must name the destructive surface that needs confirmation",
  );
  assert.ok(!("results" in result), "must not have applied any step (pre-flight refusal)");
});

test("C2: a non-destructive plan is NOT blocked by the confirmation gate (dryRun proves it passes the gate)", async () => {
  const plan = {
    intent: "platform_mutation",
    summary: "add an edge",
    steps: [
      { surfaceId: "graph.edge.add", payload: { from: "planner", to: "worker" }, title: "edge" },
    ],
  };
  // dryRun returns before applying; the point is it does NOT return blocked:explicit_confirmation_required.
  const result = await executeOperatorExecutablePlan({ plan, explicitConfirm: false, dryRun: true });
  assert.equal(result.ok, true);
  assert.notEqual(result.blocked, "explicit_confirmation_required");
});
