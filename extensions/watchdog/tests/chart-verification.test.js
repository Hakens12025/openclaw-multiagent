import test from "node:test";
import assert from "node:assert/strict";

import {
  extractSpecFromPlan,
  deriveChartNarrative,
  buildControlShape,
  generateControlDataset,
  buildControlMessage,
  diffSpecAgainstDataset,
} from "../lib/viz/chart-verification.js";

// Deterministic 0..1 rng (LCG) so generated controls are reproducible in tests.
function seededRng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function lineSpec() {
  return {
    version: 1,
    id: "latency-trend",
    label: "latency-trend",
    type: "line",
    title: "延迟趋势",
    series: [
      { name: "p50", points: [{ x: 1, y: 12 }, { x: 2, y: 9 }] },
      { name: "p95", points: [{ x: 1, y: 20.5 }, { x: 2, y: 18 }] },
    ],
  };
}

// ── extractSpecFromPlan ──────────────────────────────────────────────────────

test("extractSpecFromPlan finds the apply.chart_create payload spec", () => {
  const spec = { id: "x", type: "bar" };
  const plan = {
    steps: [
      { surfaceId: "inspect.runtime_state", payload: {} },
      { surfaceId: "apply.chart_create", payload: { spec } },
    ],
  };
  assert.equal(extractSpecFromPlan(plan), spec);
});

test("extractSpecFromPlan returns null without steps or chart step or object spec", () => {
  assert.equal(extractSpecFromPlan(null), null);
  assert.equal(extractSpecFromPlan({}), null);
  assert.equal(extractSpecFromPlan({ steps: [{ surfaceId: "apply.other" }] }), null);
  assert.equal(extractSpecFromPlan({ steps: [{ surfaceId: "apply.chart_create", payload: { spec: "nope" } }] }), null);
});

// ── deriveChartNarrative ─────────────────────────────────────────────────────

test("deriveChartNarrative pie renders exact values and 1-decimal percentages", () => {
  const narrative = deriveChartNarrative({
    type: "pie",
    title: "结果占比",
    series: [{ name: "outcomes", points: [{ x: "通过", y: 30 }, { x: "失败", y: 70 }] }],
  });
  assert.equal(narrative, "饼图「结果占比」共2片: 通过=30 (30.0%), 失败=70 (70.0%)");
});

test("deriveChartNarrative bar renders stored values verbatim (no rounding)", () => {
  const narrative = deriveChartNarrative({
    type: "bar",
    title: "Token 支出",
    series: [{ name: "tokens", points: [{ x: "worker-a", y: 100.25 }, { x: "worker-b", y: 250 }] }],
  });
  assert.equal(narrative, "柱状图「Token 支出」共2柱: worker-a=100.25, worker-b=250");
});

test("deriveChartNarrative line renders per-series segments plus overall y range", () => {
  const narrative = deriveChartNarrative(lineSpec());
  assert.equal(
    narrative,
    "折线「p50」2点: 1=12, 2=9; 折线「p95」2点: 1=20.5, 2=18; y范围 9..20.5",
  );
});

// ── buildControlShape ────────────────────────────────────────────────────────

test("buildControlShape extracts magnitude, decimals, negatives, counts, x kind", () => {
  const shape = buildControlShape({
    type: "line",
    series: [
      { name: "a", points: [{ x: "一月", y: 123.45 }, { x: "二月", y: -67.8 }] },
      { name: "b", points: [{ x: "一月", y: 5 }] },
    ],
  });
  assert.deepEqual(shape, {
    type: "line",
    seriesCount: 2,
    pointCounts: [2, 1],
    yMagnitude: 2, // floor(log10(123.45)) = 2
    yDecimals: 2, // 123.45 has 2 decimal places
    hasNegativeY: true,
    xKind: "string",
  });
});

test("buildControlShape handles numeric x, zero y, and the decimals cap", () => {
  const shape = buildControlShape({
    type: "bar",
    series: [{ name: "a", points: [{ x: 1, y: 0 }, { x: 2, y: 0.123456 }] }],
  });
  assert.equal(shape.xKind, "number");
  assert.equal(shape.hasNegativeY, false);
  assert.equal(shape.yMagnitude, 0); // |0|→1→mag 0 beats floor(log10(0.123456)) = -1
  assert.equal(shape.yDecimals, 4); // capped at 4
});

// ── generateControlDataset ───────────────────────────────────────────────────

test("generateControlDataset honors counts, magnitude bounds, decimals, unique xs", () => {
  const shape = {
    type: "line",
    seriesCount: 2,
    pointCounts: [3, 2],
    yMagnitude: 1,
    yDecimals: 2,
    hasNegativeY: false,
    xKind: "string",
  };
  const dataset = generateControlDataset(shape, 0, seededRng(42));

  assert.equal(dataset.title, "对照样本1");
  assert.equal(dataset.series.length, 2);
  assert.deepEqual(dataset.series.map((s) => s.name), ["对照线1", "对照线2"]);
  assert.deepEqual(dataset.series.map((s) => s.points.length), [3, 2]);

  for (const series of dataset.series) {
    const xs = series.points.map((p) => p.x);
    assert.equal(new Set(xs).size, xs.length, "x labels must be unique within a series");
    for (const point of series.points) {
      assert.match(String(point.x), /^样本[A-Z]+$/);
      assert.ok(point.y >= 10 && point.y < 100, `y in [10,100): ${point.y}`);
      const text = String(point.y);
      const dot = text.indexOf(".");
      assert.ok(dot === -1 || text.length - dot - 1 <= 2, `<=2 decimals: ${text}`);
    }
  }
});

test("generateControlDataset numeric x kind and negation flag", () => {
  const shape = {
    type: "bar",
    seriesCount: 1,
    pointCounts: [8],
    yMagnitude: 0,
    yDecimals: 0,
    hasNegativeY: true,
    xKind: "number",
  };
  const dataset = generateControlDataset(shape, 2, seededRng(7));
  assert.equal(dataset.title, "对照样本3");
  assert.deepEqual(dataset.series[0].points.map((p) => p.x), [1, 2, 3, 4, 5, 6, 7, 8]);
  const ys = dataset.series[0].points.map((p) => p.y);
  assert.ok(ys.some((y) => y < 0), "seeded run with hasNegativeY should produce a negative y");
  for (const y of ys) {
    assert.ok(Number.isInteger(y), `0 decimals → integer y: ${y}`);
    assert.ok(Math.abs(y) >= 1 && Math.abs(y) < 10, `|y| in [1,10): ${y}`);
  }
});

test("generateControlDataset tiny magnitudes (yMagnitude -5/-7) stay nonzero and in band", () => {
  for (const yMagnitude of [-5, -7]) {
    const shape = {
      type: "line", seriesCount: 1, pointCounts: [6],
      yMagnitude, yDecimals: 4, hasNegativeY: false, xKind: "number",
    };
    const lower = Math.pow(10, yMagnitude);
    const upper = Math.pow(10, yMagnitude + 1);
    const dataset = generateControlDataset(shape, 0, seededRng(2026));
    for (const point of dataset.series[0].points) {
      assert.notEqual(point.y, 0, `y must not collapse to zero at magnitude ${yMagnitude}`);
      assert.ok(point.y >= lower && point.y < upper, `y in [${lower},${upper}): ${point.y}`);
    }
  }
});

test("generateControlDataset never negates when hasNegativeY is false", () => {
  const shape = {
    type: "pie", seriesCount: 1, pointCounts: [5],
    yMagnitude: 2, yDecimals: 1, hasNegativeY: false, xKind: "string",
  };
  const dataset = generateControlDataset(shape, 1, seededRng(99));
  for (const point of dataset.series[0].points) {
    assert.ok(point.y > 0);
  }
});

// ── buildControlMessage ──────────────────────────────────────────────────────

test("buildControlMessage embeds every dataset number verbatim and names multi-series lines", () => {
  const shape = {
    type: "line", seriesCount: 2, pointCounts: [3, 3],
    yMagnitude: 1, yDecimals: 2, hasNegativeY: true, xKind: "string",
  };
  const dataset = generateControlDataset(shape, 0, seededRng(1234));
  const message = buildControlMessage(dataset, "line");

  assert.ok(message.startsWith("用折线图展示对照样本1: "));
  for (const series of dataset.series) {
    assert.ok(message.includes(`${series.name}: `), `names line ${series.name}`);
    for (const point of series.points) {
      assert.ok(message.includes(`${point.x}=${point.y}`), `embeds ${point.x}=${point.y}`);
    }
  }
});

test("buildControlMessage single-series pie reads like a plain user request", () => {
  const dataset = {
    title: "对照样本2",
    series: [{ name: "对照线1", points: [{ x: "样本A", y: 123.45 }, { x: "样本B", y: 67.8 }] }],
  };
  assert.equal(
    buildControlMessage(dataset, "pie"),
    "用饼图展示对照样本2: 样本A=123.45, 样本B=67.8",
  );
});

// ── diffSpecAgainstDataset ───────────────────────────────────────────────────

const judgeDataset = Object.freeze({
  title: "对照样本1",
  series: [
    { name: "对照线1", points: [{ x: "样本A", y: 12.5 }, { x: "样本B", y: 67.8 }] },
    { name: "对照线2", points: [{ x: "样本A", y: 3 }, { x: "样本B", y: -4.2 }] },
  ],
});

function faithfulSpec() {
  return {
    type: "line",
    series: [
      { name: "对照线1", points: [{ x: "样本A", y: 12.5 }, { x: "样本B", y: 67.8 }] },
      { name: "对照线2", points: [{ x: "样本A", y: 3 }, { x: "样本B", y: -4.2 }] },
    ],
  };
}

test("diffSpecAgainstDataset passes a faithful transcription", () => {
  const verdict = diffSpecAgainstDataset(faithfulSpec(), judgeDataset);
  assert.deepEqual(verdict, { pass: true, mismatches: [] });
});

test("diffSpecAgainstDataset is order-insensitive within a series", () => {
  const spec = faithfulSpec();
  spec.series[0].points.reverse();
  assert.equal(diffSpecAgainstDataset(spec, judgeDataset).pass, true);
});

test("diffSpecAgainstDataset fails one corrupted y, naming that x", () => {
  const spec = faithfulSpec();
  spec.series[0].points[1].y = 678; // 67.8 → 678 (classic transcription slip)
  const verdict = diffSpecAgainstDataset(spec, judgeDataset);
  assert.equal(verdict.pass, false);
  assert.equal(verdict.mismatches.length, 1);
  assert.ok(verdict.mismatches[0].includes("样本B"), verdict.mismatches[0]);
  assert.ok(verdict.mismatches[0].includes("期望 67.8"), verdict.mismatches[0]);
  assert.ok(verdict.mismatches[0].includes("实得 678"), verdict.mismatches[0]);
});

test("diffSpecAgainstDataset fails on a missing point", () => {
  const spec = faithfulSpec();
  spec.series[1].points = spec.series[1].points.slice(0, 1); // drop 样本B of 对照线2
  const verdict = diffSpecAgainstDataset(spec, judgeDataset);
  assert.equal(verdict.pass, false);
  assert.ok(verdict.mismatches.some((m) => m.includes("样本B") && m.includes("缺少数据点")), verdict.mismatches.join(" | "));
});

test("diffSpecAgainstDataset fails on an extra point", () => {
  const spec = faithfulSpec();
  spec.series[0].points.push({ x: "样本C", y: 1 });
  const verdict = diffSpecAgainstDataset(spec, judgeDataset);
  assert.equal(verdict.pass, false);
  assert.ok(verdict.mismatches.some((m) => m.includes("样本C") && m.includes("多出数据点")), verdict.mismatches.join(" | "));
});

test("diffSpecAgainstDataset matches reordered series by name", () => {
  const spec = faithfulSpec();
  spec.series.reverse(); // 对照线2 first — must still pair by name, not index
  assert.equal(diffSpecAgainstDataset(spec, judgeDataset).pass, true);
});

test("diffSpecAgainstDataset tolerates tiny float drift but holds zero exact", () => {
  const dataset = {
    title: "对照样本1",
    series: [{ name: "对照线1", points: [{ x: "样本A", y: 100 }, { x: "样本B", y: 0 }] }],
  };
  const close = { series: [{ name: "对照线1", points: [{ x: "样本A", y: 100.00001 }, { x: "样本B", y: 0 }] }] };
  assert.equal(diffSpecAgainstDataset(close, dataset).pass, true);
  const zeroDrift = { series: [{ name: "对照线1", points: [{ x: "样本A", y: 100 }, { x: "样本B", y: 0.0001 }] }] };
  assert.equal(diffSpecAgainstDataset(zeroDrift, dataset).pass, false);
});

test("diffSpecAgainstDataset fails a last-decimal slip at high magnitude (tolerance is step-bounded)", () => {
  const dataset = {
    title: "对照样本1",
    series: [{ name: "对照线1", points: [{ x: "样本A", y: 654321.09 }] }],
  };
  // 654321.09 → 654321.08: within the old relative epsilon (|expected|*1e-6 ≈ 0.65) but a real
  // transcription slip — the half-display-step bound (0.005 at 2 decimals) must catch it.
  const slipped = { series: [{ name: "对照线1", points: [{ x: "样本A", y: 654321.08 }] }] };
  const verdict = diffSpecAgainstDataset(slipped, dataset);
  assert.equal(verdict.pass, false);
  assert.ok(verdict.mismatches.some((m) => m.includes("期望 654321.09")), verdict.mismatches.join(" | "));
});

test("diffSpecAgainstDataset flags a duplicated x instead of silently overwriting", () => {
  const spec = faithfulSpec();
  // Duplicate 样本A in 对照线1 with a different y — the old map silently kept the LAST value.
  spec.series[0].points.push({ x: "样本A", y: 999 });
  const verdict = diffSpecAgainstDataset(spec, judgeDataset);
  assert.equal(verdict.pass, false);
  assert.ok(
    verdict.mismatches.some((m) => m.includes("样本A") && m.includes("重复数据点")),
    verdict.mismatches.join(" | "),
  );
});

test("diffSpecAgainstDataset fails null or specless input", () => {
  assert.deepEqual(diffSpecAgainstDataset(null, judgeDataset), { pass: false, mismatches: ["no spec produced"] });
  assert.equal(diffSpecAgainstDataset({ series: [] }, judgeDataset).pass, false);
  assert.equal(diffSpecAgainstDataset({ type: "line" }, judgeDataset).pass, false);
});

test("diffSpecAgainstDataset notes a series count mismatch", () => {
  const spec = { series: [faithfulSpec().series[0]] };
  const verdict = diffSpecAgainstDataset(spec, judgeDataset);
  assert.equal(verdict.pass, false);
  assert.ok(verdict.mismatches.some((m) => m.includes("系列数")), verdict.mismatches.join(" | "));
});
