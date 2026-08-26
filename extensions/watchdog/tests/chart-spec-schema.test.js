import test from "node:test";
import assert from "node:assert/strict";

import { validateChartSpec } from "../lib/viz/chart-spec-schema.js";

test("validateChartSpec accepts a valid line spec and fills defaults", () => {
  const normalized = validateChartSpec({
    id: "latency-trend",
    type: "line",
    series: [{ name: "p50", points: [{ x: 1, y: 12 }, { x: 2, y: 9 }] }],
  });

  assert.equal(normalized.version, 1);
  assert.equal(normalized.id, "latency-trend");
  assert.equal(normalized.label, "latency-trend");
  assert.equal(normalized.type, "line");
  assert.equal(normalized.title, "");
  assert.equal(normalized.dataBinding.mode, "static");
  assert.equal(normalized.render.prefer, "declarative");
  assert.deepEqual(normalized.axes, { x: { label: "" }, y: { label: "" } });
  assert.equal(normalized.series.length, 1);
  assert.deepEqual(normalized.series[0].points, [{ x: 1, y: 12 }, { x: 2, y: 9 }]);
});

test("validateChartSpec accepts a valid bar spec with string x and axis labels", () => {
  const normalized = validateChartSpec({
    id: "tokens-by-agent",
    label: "Tokens by Agent",
    type: "bar",
    title: "Token spend",
    series: [{ name: "tokens", points: [{ x: "worker-a", y: 100 }, { x: "worker-b", y: 250 }] }],
    axes: { x: { label: "agent" }, y: { label: "tokens" } },
  });

  assert.equal(normalized.type, "bar");
  assert.equal(normalized.label, "Tokens by Agent");
  assert.equal(normalized.title, "Token spend");
  assert.deepEqual(normalized.axes, { x: { label: "agent" }, y: { label: "tokens" } });
  assert.deepEqual(normalized.series[0].points, [{ x: "worker-a", y: 100 }, { x: "worker-b", y: 250 }]);
});

test("validateChartSpec accepts a valid pie spec and applies render dimensions", () => {
  const normalized = validateChartSpec({
    id: "outcome-share",
    type: "pie",
    series: [{ points: [{ x: "pass", y: 1776 }, { x: "fail", y: 0 }] }],
    render: { width: 320, height: 240 },
  });

  assert.equal(normalized.type, "pie");
  assert.equal(normalized.series[0].name, "series-1");
  assert.equal(normalized.render.width, 320);
  assert.equal(normalized.render.height, 240);
  assert.equal(normalized.render.prefer, "declarative");
});

test("validateChartSpec throws on a bad id", () => {
  assert.throws(
    () => validateChartSpec({ id: "Bad ID!", type: "line", series: [{ points: [{ x: 0, y: 0 }] }] }),
    /invalid id/,
  );
});

test("validateChartSpec throws on an unsupported type", () => {
  assert.throws(
    () => validateChartSpec({ id: "scatter-plot", type: "scatter", series: [{ points: [{ x: 0, y: 0 }] }] }),
    /type must be one of line\|bar\|pie/,
  );
});

test("validateChartSpec throws on empty series", () => {
  assert.throws(
    () => validateChartSpec({ id: "no-series", type: "line", series: [] }),
    /series must be a non-empty array/,
  );
});

test("validateChartSpec throws on a point with a non-numeric y", () => {
  assert.throws(
    () => validateChartSpec({ id: "bad-point", type: "line", series: [{ points: [{ x: 0, y: "nope" }] }] }),
    /must have a numeric y/,
  );
});

test("validateChartSpec accepts a line+sse spec and normalizes the binding with defaults", () => {
  const normalized = validateChartSpec({
    id: "active-groups-live",
    type: "line",
    series: [{ name: "active", points: [{ x: 0, y: 0 }] }],
    dataBinding: { mode: "sse", binding: { source: "inspect.agent_groups" } },
  });

  assert.equal(normalized.dataBinding.mode, "sse");
  assert.deepEqual(normalized.dataBinding.binding, {
    source: "inspect.agent_groups",
    intervalMs: 25000,
    maxPoints: 30,
  });
  // field is optional and omitted when not supplied
  assert.equal("field" in normalized.dataBinding.binding, false);
});

test("validateChartSpec keeps an explicit sse field and clamps interval/maxPoints", () => {
  const normalized = validateChartSpec({
    id: "runtime-state-live",
    type: "line",
    series: [{ points: [{ x: 0, y: 0 }] }],
    dataBinding: {
      mode: "sse",
      binding: { source: "inspect.runtime_state", field: "queue.depth", intervalMs: 1000, maxPoints: 9999 },
    },
  });

  assert.deepEqual(normalized.dataBinding.binding, {
    source: "inspect.runtime_state",
    field: "queue.depth",
    intervalMs: 5000, // clamped up from 1000
    maxPoints: 200, // clamped down from 9999
  });
});

test("validateChartSpec rejects sse on a bar chart (live data must be a line time series)", () => {
  assert.throws(
    () => validateChartSpec({
      id: "tokens-live",
      type: "bar",
      series: [{ points: [{ x: "a", y: 1 }] }],
      dataBinding: { mode: "sse", binding: { source: "inspect.runtime_state" } },
    }),
    /requires type "line"/,
  );
});

test("validateChartSpec rejects sse without a binding object", () => {
  assert.throws(
    () => validateChartSpec({
      id: "no-binding-live",
      type: "line",
      series: [{ points: [{ x: 0, y: 0 }] }],
      dataBinding: { mode: "sse" },
    }),
    /requires a binding object/,
  );
});

test("validateChartSpec rejects sse with a missing/blank binding.source", () => {
  assert.throws(
    () => validateChartSpec({
      id: "no-source-live",
      type: "line",
      series: [{ points: [{ x: 0, y: 0 }] }],
      dataBinding: { mode: "sse", binding: { field: "x" } },
    }),
    /binding\.source must be a non-empty string/,
  );
});

test("validateChartSpec rejects an sse binding.source with a bad charset (full pattern, not just the prefix)", () => {
  const bad = (source) => assert.throws(
    () => validateChartSpec({
      id: "bad-charset-live",
      type: "line",
      series: [{ points: [{ x: 0, y: 0 }] }],
      dataBinding: { mode: "sse", binding: { source } },
    }),
    /matching/,
    `source should be rejected: ${source}`,
  );
  bad("inspect.Runtime_State"); // uppercase
  bad("inspect.runtime state"); // whitespace
  bad("inspect.foo/../bar"); // path-ish separator
  bad("inspect."); // empty tail
});

test("validateChartSpec caps embedded data at 10 series and 200 points per series", () => {
  const point = { x: 1, y: 1 };
  const seriesOf = (count) => Array.from({ length: count }, (unused, i) => ({ name: `s${i}`, points: [point] }));

  assert.throws(
    () => validateChartSpec({ id: "too-many-series", type: "line", series: seriesOf(11) }),
    /at most 10 entries/,
  );
  assert.throws(
    () => validateChartSpec({
      id: "too-many-points",
      type: "line",
      series: [{ name: "s", points: Array.from({ length: 201 }, (unused, i) => ({ x: i, y: i })) }],
    }),
    /at most 200 points/,
  );

  // Boundary: exactly 10 series × 200 points is legal.
  const maxed = validateChartSpec({
    id: "maxed-out",
    type: "line",
    series: Array.from({ length: 10 }, (unused, s) => ({
      name: `s${s}`,
      points: Array.from({ length: 200 }, (unusedPoint, i) => ({ x: i, y: i })),
    })),
  });
  assert.equal(maxed.series.length, 10);
  assert.equal(maxed.series[9].points.length, 200);
});

test("validateChartSpec rejects an sse binding.source not starting with inspect.", () => {
  assert.throws(
    () => validateChartSpec({
      id: "bad-source-live",
      type: "line",
      series: [{ points: [{ x: 0, y: 0 }] }],
      dataBinding: { mode: "sse", binding: { source: "apply.something" } },
    }),
    /starting with "inspect\."/,
  );
});

test("validateChartSpec rejects an unknown dataBinding.mode", () => {
  assert.throws(
    () => validateChartSpec({
      id: "bad-mode",
      type: "line",
      series: [{ points: [{ x: 0, y: 0 }] }],
      dataBinding: { mode: "websocket", binding: { source: "inspect.x" } },
    }),
    /dataBinding\.mode must be one of static\|sse/,
  );
});

test("validateChartSpec leaves a static spec byte-identical (no binding leaks in)", () => {
  // Explicit static mode with a stray binding payload — binding must be dropped.
  const normalized = validateChartSpec({
    id: "still-static",
    type: "bar",
    series: [{ points: [{ x: "a", y: 1 }] }],
    dataBinding: { mode: "static", binding: { source: "inspect.should-be-ignored" } },
  });

  assert.deepEqual(normalized.dataBinding, { mode: "static" });
  assert.equal("binding" in normalized.dataBinding, false);

  // Omitting dataBinding entirely still normalizes to static.
  const implicit = validateChartSpec({
    id: "implicit-static",
    type: "line",
    series: [{ points: [{ x: 0, y: 1 }] }],
  });
  assert.deepEqual(implicit.dataBinding, { mode: "static" });
});
