import test from "node:test";
import assert from "node:assert/strict";

import { normalizeOperatorBrainPlanResult } from "../lib/operator/operator-plan.js";

// Resilience: the model sometimes appends ONE unsupported/hallucinated step to an otherwise-valid
// build plan. The PLAN path must drop only the bad step(s) + warn — NOT discard the whole plan
// (the old all-or-nothing throw made operator return advice_only with zero steps, wasting a good plan).

test("one unsupported step is dropped; the valid steps + intent survive, with a warning", () => {
  const brainResult = {
    plan: {
      intent: "create_agent",
      summary: "build copy loop",
      steps: [
        { surfaceId: "agents.create", payload: { id: "copywriter", role: "executor" } },
        { surfaceId: "graph.edge.add", payload: { from: "copywriter", to: "reviewer1" } },
        { surfaceId: "agents.totally_fake_surface", payload: {} }, // unsupported → must be dropped
      ],
    },
    source: "operator_brain_llm",
    plannerModel: "test-model",
  };
  const out = normalizeOperatorBrainPlanResult(brainResult, "连接 copywriter 到 reviewer1 建文案迭代环");
  assert.deepEqual(out.plan.steps.map((s) => s.surfaceId), ["agents.create", "graph.edge.add"], "keeps the 2 valid steps");
  assert.notEqual(out.intent, "advice_only", "a plan with valid steps must NOT collapse to advice_only");
  assert.ok((out.plan.warnings || []).some((w) => /跳过|totally_fake_surface/.test(w)), "warns about the dropped step");
});

test("when ALL steps are unsupported, the plan correctly degrades to advice_only with zero steps", () => {
  const brainResult = {
    plan: { intent: "create_agent", steps: [{ surfaceId: "fake.one", payload: {} }, { surfaceId: "fake.two", payload: {} }] },
    source: "operator_brain_llm",
  };
  const out = normalizeOperatorBrainPlanResult(brainResult, "随便建点东西");
  assert.equal(out.plan.steps.length, 0);
  assert.equal(out.intent, "advice_only");
});

test("a fully-valid plan is unchanged (no spurious warnings)", () => {
  const brainResult = {
    plan: { intent: "create_agent", steps: [{ surfaceId: "agents.create", payload: { id: "w1", role: "executor" } }] },
    source: "operator_brain_llm",
  };
  const out = normalizeOperatorBrainPlanResult(brainResult, "建一个 agent");
  assert.equal(out.plan.steps.length, 1);
  assert.ok(!(out.plan.warnings || []).some((w) => /跳过/.test(w)), "no drop-warning when all steps are valid");
});
