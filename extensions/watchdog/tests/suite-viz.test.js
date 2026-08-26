import test from "node:test";
import assert from "node:assert/strict";

import {
  buildStaticProbeSpec,
  buildSseProbeSpec,
  buildMalformedSpec,
  classifyChartCreate,
  evaluateSseNormalization,
  STATIC_PROBE_ID,
  SSE_PROBE_ID,
} from "../lib/formal-runtime/suite-viz.js";
import { validateChartSpec } from "../lib/viz/chart-spec-schema.js";

test("static probe spec passes the real validateChartSpec", () => {
  const spec = validateChartSpec(buildStaticProbeSpec());
  assert.equal(spec.id, STATIC_PROBE_ID);
  assert.equal(spec.type, "bar");
  assert.equal(spec.dataBinding.mode, "static");
  assert.ok(spec.series.length >= 1);
});

test("sse probe spec is valid and its live binding is clamped by validateChartSpec", () => {
  const spec = validateChartSpec(buildSseProbeSpec());
  assert.equal(spec.id, SSE_PROBE_ID);
  assert.equal(spec.type, "line");           // sse requires line
  assert.equal(spec.dataBinding.mode, "sse");
  assert.equal(spec.dataBinding.binding.source, "inspect.runtime_state");
  assert.equal(spec.dataBinding.binding.intervalMs, 5000);  // 1000 clamped up to the 5000 floor
  assert.equal(spec.dataBinding.binding.maxPoints, 200);    // 999 clamped down to the 200 ceiling
});

test("malformed probe spec is rejected by the real validateChartSpec", () => {
  assert.throws(() => validateChartSpec(buildMalformedSpec()), /series must be a non-empty array/);
});

test("classifyChartCreate: ok+matching id -> pass; ok:false or id mismatch -> fail", () => {
  const pass = classifyChartCreate({ ok: true, chart: { id: STATIC_PROBE_ID, spec: { type: "bar" } } }, STATIC_PROBE_ID);
  assert.equal(pass.status, "pass");

  assert.equal(classifyChartCreate({ ok: false, error: "boom" }, STATIC_PROBE_ID).status, "fail");
  assert.equal(classifyChartCreate({ ok: true, chart: { id: "other" } }, STATIC_PROBE_ID).status, "fail");
  assert.equal(classifyChartCreate(null, STATIC_PROBE_ID).status, "fail");
});

test("evaluateSseNormalization: normalized clamped binding -> ok; drift/absent -> not ok", () => {
  // Feed the actually-normalized chart (validateChartSpec output wrapped as a stored entry).
  const chart = { spec: validateChartSpec(buildSseProbeSpec()) };
  const good = evaluateSseNormalization(chart);
  assert.equal(good.ok, true);

  // Wrong source / un-clamped interval -> not ok.
  const drifted = evaluateSseNormalization({ spec: { dataBinding: { mode: "sse", binding: { source: "inspect.runtime_state", intervalMs: 1000, maxPoints: 200 } } } });
  assert.equal(drifted.ok, false);
  assert.match(drifted.evidence, /intervalMs=1000/);

  // Not an sse binding at all -> not ok.
  assert.equal(evaluateSseNormalization({ spec: { dataBinding: { mode: "static" } } }).ok, false);
  assert.equal(evaluateSseNormalization(null).ok, false);
});
