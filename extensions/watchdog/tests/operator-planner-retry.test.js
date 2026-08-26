import test, { mock } from "node:test";
import assert from "node:assert/strict";

// Reliability: a single retry recovers minimax's intermittent degenerate output (BUILD intent with
// empty steps[], or malformed JSON), WITHOUT masking real provider/socket failures. Mock only the
// terminal planner call (spread the real llm-planner exports so parsePlannerJson etc. survive);
// drive the real exported helpers. Needs --experimental-test-module-mocks.

import * as realPlanner from "../lib/llm/llm-planner.js";

let plannerScript = [];
let plannerCalls = [];
mock.module("../lib/llm/llm-planner.js", {
  namedExports: {
    ...realPlanner,
    callOpenAICompatiblePlanner: async (args) => {
      plannerCalls.push(args);
      const next = plannerScript.shift();
      if (next?.throw) throw next.throw;
      return next?.plan;
    },
  },
});

const { isDegeneratePlannerPlan, callPlannerWithSingleRetry } = await import("../lib/operator/operator-brain.js");

const GOOD = { intent: "graph_mutation", steps: [{ surfaceId: "graph.edge.add" }] };
const EMPTY_BUILD = { intent: "create_agent", steps: [] };
const ADVICE = { intent: "advice_only", steps: [] };
const parseErr = () => Object.assign(new Error("planner JSON parse failed after repair"), { code: "PLANNER_JSON_PARSE_FAILED" });

test("isDegeneratePlannerPlan: build-intent + empty steps is degenerate; advice/null/has-steps are not", () => {
  assert.equal(isDegeneratePlannerPlan(EMPTY_BUILD), true);
  assert.equal(isDegeneratePlannerPlan({ intent: "platform_mutation", steps: [] }), true);
  assert.equal(isDegeneratePlannerPlan(GOOD), false, "has steps → not degenerate");
  assert.equal(isDegeneratePlannerPlan(ADVICE), false, "advice_only → not a build → not degenerate");
  assert.equal(isDegeneratePlannerPlan({ steps: [] }), false, "no intent → not degenerate");
  assert.equal(isDegeneratePlannerPlan(null), false);
});

test("healthy plan → exactly one call, no retry", async () => {
  plannerScript = [{ plan: GOOD }]; plannerCalls = [];
  const out = await callPlannerWithSingleRetry({ userPrompt: "u" });
  assert.deepEqual(out, GOOD);
  assert.equal(plannerCalls.length, 1);
});

test("empty-build then good → retries once, re-ask nudge added, returns good", async () => {
  plannerScript = [{ plan: EMPTY_BUILD }, { plan: GOOD }]; plannerCalls = [];
  const out = await callPlannerWithSingleRetry({ userPrompt: "u" });
  assert.deepEqual(out, GOOD);
  assert.equal(plannerCalls.length, 2);
  assert.match(plannerCalls[1].userPrompt, /non-empty steps/);
});

test("parse-error then good → retries once, returns good", async () => {
  plannerScript = [{ throw: parseErr() }, { plan: GOOD }]; plannerCalls = [];
  const out = await callPlannerWithSingleRetry({ userPrompt: "u" });
  assert.deepEqual(out, GOOD);
  assert.equal(plannerCalls.length, 2);
});

test("both degenerate → 2 calls, no infinite loop (returns the retry result)", async () => {
  plannerScript = [{ plan: EMPTY_BUILD }, { plan: EMPTY_BUILD }]; plannerCalls = [];
  const out = await callPlannerWithSingleRetry({ userPrompt: "u" });
  assert.deepEqual(out, EMPTY_BUILD);
  assert.equal(plannerCalls.length, 2);
});

test("parse-error twice → rejects PLANNER_JSON_PARSE_FAILED after 2 calls", async () => {
  plannerScript = [{ throw: parseErr() }, { throw: parseErr() }]; plannerCalls = [];
  await assert.rejects(() => callPlannerWithSingleRetry({ userPrompt: "u" }), (e) => e.code === "PLANNER_JSON_PARSE_FAILED");
  assert.equal(plannerCalls.length, 2);
});

test("network/socket error → rethrown after ONE call (retry never masks a provider/GLM-socket failure)", async () => {
  const sockErr = Object.assign(new Error("fetch failed"), { cause: { code: "UND_ERR_SOCKET" } });
  plannerScript = [{ throw: sockErr }, { plan: GOOD }]; plannerCalls = [];
  await assert.rejects(() => callPlannerWithSingleRetry({ userPrompt: "u" }), /fetch failed/);
  assert.equal(plannerCalls.length, 1, "must NOT retry on a non-parse error");
});

test("advice_only + empty steps → one call, no wasteful retry", async () => {
  plannerScript = [{ plan: ADVICE }]; plannerCalls = [];
  const out = await callPlannerWithSingleRetry({ userPrompt: "u" });
  assert.deepEqual(out, ADVICE);
  assert.equal(plannerCalls.length, 1);
});
