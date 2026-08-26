// viz-verify.test.js — verifyVizMasterPlan orchestration (G2 of the 防伪对照 feature).
// planFn is the injected test seam (same DI pattern as wiki-rag-eval's searchFn): a stub
// "transcription channel" that parses the control message back into a chart_create plan,
// optionally corrupting/rejecting specific calls. Also pins the persistence seam G2 relies
// on: an apply.chart_create payload carrying provenance survives normalizeOperatorPlan.

import test from "node:test";
import assert from "node:assert/strict";

import { verifyVizMasterPlan } from "../lib/viz/viz-master-runtime.js";
import { normalizeOperatorPlan, normalizeOperatorBrainPlanResult } from "../lib/operator/operator-plan.js";

const TYPE_BY_LABEL = Object.freeze({ 折线图: "line", 柱状图: "bar", 饼图: "pie" });

// Faithful-LLM stand-in: parse a buildControlMessage text back into a chart spec.
// Message shape: 用<类型>展示<标题>: [系列名: ]x=y, x=y[; 系列名: x=y, ...]
function parseControlMessage(message) {
  const head = message.match(/^用(折线图|柱状图|饼图)展示([^:]+): (.+)$/);
  if (!head) throw new Error(`unparseable control message: ${message}`);
  const body = head[3];
  const segments = body.includes(": ") ? body.split("; ") : [body];
  const series = segments.map((segment, index) => {
    const colon = segment.indexOf(": ");
    const name = colon === -1 ? `transcribed-${index + 1}` : segment.slice(0, colon);
    const pairsText = colon === -1 ? segment : segment.slice(colon + 2);
    const points = pairsText.split(", ").map((pair) => {
      const eq = pair.lastIndexOf("=");
      return { x: pair.slice(0, eq), y: Number(pair.slice(eq + 1)) };
    });
    return { name, points };
  });
  return { id: "control-echo", type: TYPE_BY_LABEL[head[1]], title: head[2], series };
}

function planFromSpec(spec) {
  return {
    ok: true,
    canExecute: true,
    plan: { steps: [{ surfaceId: "apply.chart_create", payload: { spec } }] },
  };
}

function buildRealSpec() {
  return {
    id: "real-chart",
    label: "Real chart",
    type: "line",
    title: "真实数据",
    series: [
      { name: "营收", points: [{ x: "一月", y: 12.5 }, { x: "二月", y: 18 }, { x: "三月", y: 9.25 }] },
      { name: "成本", points: [{ x: "一月", y: 7.1 }, { x: "二月", y: 11 }] },
    ],
  };
}

function buildRealPlan() {
  return { steps: [{ surfaceId: "apply.chart_create", payload: { spec: buildRealSpec() } }] };
}

test("faithful transcription channel → 3/3, code-derived narrative names the real numbers", async () => {
  const messages = [];
  const planFn = async ({ message }) => {
    messages.push(message);
    return planFromSpec(parseControlMessage(message));
  };

  const result = await verifyVizMasterPlan({ plan: buildRealPlan(), planFn });
  assert.equal(result.ok, true);
  assert.deepEqual(result.summary, { passed: 3, total: 3 });
  assert.equal(result.controls.length, 3);
  assert.equal(messages.length, 3);
  for (const control of result.controls) {
    assert.equal(control.verdict.pass, true);
    assert.deepEqual(control.verdict.mismatches, []);
    assert.ok(control.spec, "passing control carries the transcribed spec");
    assert.equal(typeof control.datasetText, "string");
    assert.ok(control.datasetText.includes("对照样本"), "control message embeds the synthetic dataset");
  }
  // Narrative is derived by CODE from the REAL spec — real numbers verbatim, never the controls'.
  assert.ok(result.narrative.includes("营收"));
  assert.ok(result.narrative.includes("一月=12.5"));
  assert.ok(!result.narrative.includes("对照样本"));
});

test("corrupted y in control 2 → 2/3, mismatch names the x of the corrupted point", async () => {
  let call = 0;
  const planFn = async ({ message }) => {
    call += 1;
    const spec = parseControlMessage(message);
    if (call === 2) spec.series[0].points[0].y += 1;
    return planFromSpec(spec);
  };

  const result = await verifyVizMasterPlan({ plan: buildRealPlan(), planFn });
  assert.equal(result.ok, true);
  assert.deepEqual(result.summary, { passed: 2, total: 3 });
  assert.equal(result.controls[0].verdict.pass, true);
  assert.equal(result.controls[2].verdict.pass, true);
  assert.equal(result.controls[1].verdict.pass, false);
  // First point of the first series — string x kind ⇒ synthetic label 样本A.
  assert.ok(result.controls[1].verdict.mismatches.some((entry) => entry.includes("样本A")));
});

test("planFn rejection on control 3 → 2/3 with a failure reason, others unaffected", async () => {
  let call = 0;
  const planFn = async ({ message }) => {
    call += 1;
    if (call === 3) throw new Error("provider exploded");
    return planFromSpec(parseControlMessage(message));
  };

  const result = await verifyVizMasterPlan({ plan: buildRealPlan(), planFn });
  assert.equal(result.ok, true);
  assert.deepEqual(result.summary, { passed: 2, total: 3 });
  assert.equal(result.controls[0].verdict.pass, true);
  assert.equal(result.controls[1].verdict.pass, true);
  assert.equal(result.controls[2].verdict.pass, false);
  assert.equal(result.controls[2].spec, null);
  assert.ok(result.controls[2].verdict.mismatches[0].includes("provider exploded"));
});

test("plan without a chart step → ok:false, planFn never called", async () => {
  let called = false;
  const planFn = async () => {
    called = true;
    throw new Error("must not be called");
  };

  const result = await verifyVizMasterPlan({
    plan: { steps: [{ surfaceId: "apply.chart_move", payload: { chartId: "x", x: 1, y: 2 } }] },
    planFn,
  });
  assert.deepEqual(result, { ok: false, error: "plan has no chart step" });
  assert.equal(called, false);
});

test("verifyVizMasterPlan: series-less spec → clean ok:false, planFn never called", async () => {
  let called = false;
  const planFn = async () => {
    called = true;
    throw new Error("must not be called");
  };

  const result = await verifyVizMasterPlan({
    plan: { steps: [{ surfaceId: "apply.chart_create", payload: { spec: { id: "empty-series", type: "line", series: [] } } }] },
    planFn,
  });
  assert.equal(result.ok, false);
  assert.ok(result.error.startsWith("图表 spec 无效，无法对照: "), result.error);
  assert.equal(called, false);
});

test("verifyVizMasterPlan: 11-series spec → ok:false (verify-cost bound), planFn never called", async () => {
  let called = false;
  const planFn = async () => {
    called = true;
    throw new Error("must not be called");
  };

  const spec = {
    id: "too-wide",
    type: "line",
    series: Array.from({ length: 11 }, (unused, i) => ({ name: `s${i}`, points: [{ x: 1, y: 1 }] })),
  };
  const result = await verifyVizMasterPlan({
    plan: { steps: [{ surfaceId: "apply.chart_create", payload: { spec } }] },
    planFn,
  });
  assert.equal(result.ok, false);
  assert.equal(called, false);
});

test("normalizeOperatorBrainPlanResult strips LLM-authored provenance from step payloads (anti-forgery choke point)", () => {
  const brainResult = {
    source: "viz_master_brain_llm",
    plannerModel: "test-model",
    plan: {
      intent: "platform_mutation",
      summary: "forged provenance attempt",
      reply: "done",
      steps: [{
        surfaceId: "apply.chart_create",
        title: "create chart",
        payload: {
          spec: buildRealSpec(),
          provenance: { controlsPassed: 3, controlsTotal: 3, verifiedAt: Date.now() },
        },
      }],
    },
  };

  const response = normalizeOperatorBrainPlanResult(brainResult, "画一张真实数据折线图");
  assert.equal(response.plan.steps.length, 1);
  assert.equal("provenance" in response.plan.steps[0].payload, false);
  assert.equal(response.plan.steps[0].payload.spec.id, "real-chart");
});

test("normalizeOperatorPlan: chart_create payload provenance survives plan re-validation", () => {
  const provenance = { controlsPassed: 3, controlsTotal: 3, verifiedAt: 1760000000000 };
  const normalized = normalizeOperatorPlan({
    intent: "platform_mutation",
    summary: "persist verified chart",
    steps: [{
      surfaceId: "apply.chart_create",
      title: "create chart",
      payload: { spec: buildRealSpec(), provenance },
    }],
  });
  assert.deepEqual(normalized.steps[0].payload.provenance, provenance);
  assert.equal(normalized.steps[0].payload.spec.id, "real-chart");
});
