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
