import test, { mock } from "node:test";
import assert from "node:assert/strict";

// viz-master brain/runtime: the LLM planner half of the visualization master meta-agent.
// Mirrors operator-brain tests — mock the terminal planner call (and the live config / chart store /
// wiki search the brain reads) so the brain runs deterministically offline, then assert it yields a
// SINGLE apply.chart_create step carrying payload.spec, and emits NO verify step. The planner mock
// spreads the real llm-planner exports so parsePlannerJson etc. survive. Needs
// --experimental-test-module-mocks.

import * as realPlanner from "../lib/llm-planner.js";
import * as realCapability from "../lib/capability/capability-registry.js";
import * as realChartRegistry from "../lib/control-plane/chart-registry.js";
import * as realWikiSearch from "../lib/operator/wiki-rag-search.js";

// A config with one openai-completions provider so resolveOperatorBrainModel resolves baseUrl+apiKey
// (so the brain reaches the planner mock instead of throwing "provider is not ready").
const FAKE_CONFIG = {
  agents: { defaults: { model: "ark-openai/minimax-m2.5" } },
  models: {
    providers: {
      "ark-openai": {
        api: "openai-completions",
        baseUrl: "https://example.test/v1",
        apiKey: "test-key",
        models: [{ id: "minimax-m2.5" }],
      },
    },
  },
};

let plannerScript = [];
let plannerCalls = [];

mock.module("../lib/llm-planner.js", {
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

mock.module("../lib/capability/capability-registry.js", {
  namedExports: {
    ...realCapability,
    loadOpenClawConfig: async () => FAKE_CONFIG,
  },
});

mock.module("../lib/control-plane/chart-registry.js", {
  namedExports: {
    ...realChartRegistry,
    listCharts: async () => [],
  },
});

// searchWiki never throws in production (degraded → empty); keep it empty + offline here.
mock.module("../lib/operator/wiki-rag-search.js", {
  namedExports: {
    ...realWikiSearch,
    searchWiki: async () => ({ results: [] }),
  },
});

const { buildVizMasterBrainSystemPrompt, planWithVizMasterBrain } = await import("../lib/viz/viz-master-brain.js");
const { buildVizMasterPlan } = await import("../lib/viz/viz-master-runtime.js");

const CHART_SPEC = {
  id: "daily-pnl",
  type: "line",
  title: "Daily PnL",
  series: [{ name: "pnl", points: [{ x: "Mon", y: 12 }, { x: "Tue", y: 18 }] }],
};

const CHART_PLAN = {
  intent: "platform_mutation",
  summary: "build a daily pnl line chart",
  reply: "已生成一张折线图。",
  steps: [{ surfaceId: "apply.chart_create", title: "create chart", summary: "render the data", payload: { spec: CHART_SPEC } }],
};

function resetScript(plan) {
  plannerScript = [{ plan }];
  plannerCalls = [];
}

test("system prompt: owns chart family, single apply.chart_create, never agent/graph/knowledge, never verify", () => {
  const prompt = buildVizMasterBrainSystemPrompt();
  assert.match(prompt, /Visualization Master/i);
  assert.match(prompt, /apply\.chart_create/);
  assert.match(prompt, /never emit a verify step/i);
  assert.match(prompt, /agent \/ graph \/ knowledge/i);
});

test("planWithVizMasterBrain: returns the planner chart plan + viz source/context", async () => {
  resetScript(CHART_PLAN);
  const out = await planWithVizMasterBrain({ message: "把每天的盈亏画成折线图" });
  assert.equal(out.ok, true);
  assert.equal(out.source, "viz_master_brain_llm");
  assert.equal(out.plan.intent, "platform_mutation");
  assert.equal(out.plan.steps.length, 1);
  assert.equal(out.plan.steps[0].surfaceId, "apply.chart_create");
  assert.equal(plannerCalls.length, 1);
  // surfaces handed to the planner are narrowed to the chart family (no agent/graph surfaces).
  const surfaceIds = out.context.executableSurfaces.map((s) => s.id);
  assert.ok(surfaceIds.includes("apply.chart_create"));
  assert.ok(!surfaceIds.includes("agents.create"), "viz-master must not see agent surfaces");
  assert.ok(!surfaceIds.includes("graph.edge.add"), "viz-master must not see graph surfaces");
});

test("buildVizMasterPlan: yields exactly ONE apply.chart_create step with payload.spec and NO verify step", async () => {
  resetScript(CHART_PLAN);
  const response = await buildVizMasterPlan({ message: "用折线图展示每日盈亏" });

  assert.equal(response.ok, true);
  assert.equal(response.canExecute, true, "a real chart build step must be executable");
  assert.equal(response.plan.steps.length, 1, "exactly one step");

  const step = response.plan.steps[0];
  assert.equal(step.surfaceId, "apply.chart_create");
  assert.ok(step.payload && typeof step.payload.spec === "object", "step must carry payload.spec");
  assert.equal(step.payload.spec.id, "daily-pnl");
  assert.equal(step.payload.spec.type, "line");

  // The red line: NO verify step ever (apply.chart_create has no verificationCapability).
  const verifySurfaces = response.plan.steps.filter((s) => /^(verify\.|test\.|test_runs\.)/.test(s.surfaceId));
  assert.equal(verifySurfaces.length, 0, "viz-master must never emit a verify step");
});

test("buildVizMasterPlan: a degenerate build plan (build intent, empty steps) triggers ONE retry", async () => {
  // mirrors operator's degenerate-plan retry — the same shared callPlannerWithSingleRetry machinery.
  plannerScript = [{ plan: { intent: "create_agent", steps: [] } }, { plan: CHART_PLAN }];
  plannerCalls = [];
  const response = await buildVizMasterPlan({ message: "画个折线图" });
  assert.equal(response.plan.steps.length, 1);
  assert.equal(response.plan.steps[0].surfaceId, "apply.chart_create");
  assert.equal(plannerCalls.length, 2, "degenerate plan must re-ask exactly once");
});

test("buildVizMasterPlan: non-chart request → planner advice_only → advice fallback, zero steps", async () => {
  resetScript({ intent: "advice_only", reply: "建 agent 是 operator 的活。", steps: [] });
  const response = await buildVizMasterPlan({ message: "帮我建一个新 agent" });
  assert.equal(response.plan.steps.length, 0);
  assert.equal(response.canExecute, false);
});
