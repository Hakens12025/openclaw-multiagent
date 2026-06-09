// operator-meta-delegate.test.js — the meta.delegate plan-step fork (operator → another meta-agent,
// in-process R2 delegation). Unit-covers the validatePlanStep/normalizeOperatorPlan fork; the live
// operator→viz-master delegation (which needs an LLM) is proven by the Tier-2 live smoke.

import test from "node:test";
import assert from "node:assert/strict";
import { normalizeOperatorPlan } from "../lib/operator/operator-plan.js";
import { executeOperatorExecutablePlan } from "../lib/operator/operator-executor.js";

test("normalizeOperatorPlan accepts a meta.delegate step (non-surface; keeps targetActor+request)", () => {
  const plan = normalizeOperatorPlan({
    intent: "platform_mutation",
    summary: "delegate a chart to viz-master",
    steps: [
      { surfaceId: "meta.delegate", title: "make chart", payload: { targetActor: "viz-master", request: "bar chart of A=3 B=7" } },
    ],
  });
  assert.equal(plan.steps.length, 1);
  const step = plan.steps[0];
  assert.equal(step.surfaceId, "meta.delegate");
  assert.deepEqual(step.payload, { targetActor: "viz-master", request: "bar chart of A=3 B=7" });
  assert.equal(step.title, "make chart");
});

test("meta.delegate missing targetActor OR request is rejected", () => {
  assert.throws(
    () => normalizeOperatorPlan({
      intent: "platform_mutation", summary: "x",
      steps: [{ surfaceId: "meta.delegate", payload: { request: "no target" } }],
    }),
    /requires payload.targetActor and payload.request/u,
  );
  assert.throws(
    () => normalizeOperatorPlan({
      intent: "platform_mutation", summary: "x",
      steps: [{ surfaceId: "meta.delegate", payload: { targetActor: "viz-master" } }],
    }),
    /requires payload.targetActor and payload.request/u,
  );
});

test("the fork does not weaken validation: a non-meta.delegate unknown surfaceId still throws", () => {
  assert.throws(
    () => normalizeOperatorPlan({
      intent: "platform_mutation", summary: "x",
      steps: [{ surfaceId: "bogus.surface", payload: {} }],
    }),
    /unsupported operator step/u,
  );
});

test("meta.delegate is operator-only: a non-operator actor cannot delegate (no lateral escalation)", async () => {
  // Rejected at the actor gate BEFORE runMetaDelegate, so no LLM call. Proves a delegated sub-plan
  // (which runs under actor:"viz-master") can never itself re-delegate.
  const result = await executeOperatorExecutablePlan({
    plan: {
      intent: "platform_mutation",
      summary: "x",
      steps: [{ surfaceId: "meta.delegate", payload: { targetActor: "viz-master", request: "bar chart of A=1 B=2" } }],
    },
    actor: "viz-master",
    explicitConfirm: true,
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /operator-only/u);
});
