// chart-verification.js — pure verification core for the viz accept-stage 防伪对照 (anti-forgery
// control) feature. No I/O, no LLM calls. The design invariants live here:
//   - the human-facing narrative is derived by CODE from the normalized spec (the LLM never writes it),
//   - synthetic control datasets are code-generated ground truth, shaped like the real request,
//   - control specs transcribed back by the LLM are judged by CODE (diffSpecAgainstDataset).
// Charts are NON-truth artifacts; nothing here touches structure-snapshot/readTruths.
//
// Normalized spec shape (see ./chart-spec-schema.js):
//   { version, id, label, type: "line"|"bar"|"pie", title,
//     series: [{ name, points: [{ x: number|string, y: number }] }], axes, dataBinding, render }

import { normalizeString } from "../core/normalize.js";

const TYPE_LABELS = Object.freeze({ line: "折线图", bar: "柱状图", pie: "饼图" });

const Y_RELATIVE_EPSILON = 1e-6;
const MAX_Y_DECIMALS = 4;

// ── 1. plan → spec ───────────────────────────────────────────────────────────

// Server-side twin of extractChartCreateSpec in dashboard-charts.js (which reads
// planResponse.plan.steps — here the caller hands us the plan itself).
export function extractSpecFromPlan(plan) {
  const steps = plan?.steps;
  if (!Array.isArray(steps)) return null;
  const step = steps.find((entry) => entry && entry.surfaceId === "apply.chart_create");
  const spec = step?.payload?.spec;
  return spec && typeof spec === "object" ? spec : null;
}

// ── 2. code-derived narrative ────────────────────────────────────────────────

// Render data numbers EXACTLY as stored — String(y), never rounded. Only the pie
// percentages are derived (to 1 decimal), and they are labeled as percentages.
function formatPointList(points) {
  return points.map((point) => `${point.x}=${point.y}`).join(", ");
}

function flattenPoints(series) {
  return series.flatMap((entry) => entry.points);
}

// Deterministic zh narrative of exactly what will be drawn, derived by code from the
// normalized spec so a hallucinated spec cannot narrate itself into consistency.
export function deriveChartNarrative(spec) {
  const title = normalizeString(spec.title) ?? normalizeString(spec.label) ?? spec.id ?? "";

  if (spec.type === "pie") {
    const slices = flattenPoints(spec.series);
    const absTotal = slices.reduce((sum, point) => sum + Math.abs(point.y), 0);
    const items = slices.map((point) => {
      const pct = absTotal === 0 ? "0.0" : ((point.y / absTotal) * 100).toFixed(1);
      return `${point.x}=${point.y} (${pct}%)`;
    });
    return `饼图「${title}」共${slices.length}片: ${items.join(", ")}`;
  }

  if (spec.type === "line") {
    const segments = spec.series.map(
      (entry) => `折线「${entry.name}」${entry.points.length}点: ${formatPointList(entry.points)}`,
    );
    const ys = flattenPoints(spec.series).map((point) => point.y);
    segments.push(`y范围 ${Math.min(...ys)}..${Math.max(...ys)}`);
    return segments.join("; ");
  }

  // bar — the only remaining normalized type. Bars are flattened in series order.
  const bars = flattenPoints(spec.series);
  return `柱状图「${title}」共${bars.length}柱: ${formatPointList(bars)}`;
}

// ── 3. real spec → control shape ─────────────────────────────────────────────

// Decimal places as displayed by String(y); exponent-form numbers are already beyond
// display precision, treat them as max.
function decimalPlacesOf(value) {
  const text = String(value);
  if (text.includes("e") || text.includes("E")) return MAX_Y_DECIMALS;
  const dotIndex = text.indexOf(".");
  return dotIndex === -1 ? 0 : text.length - dotIndex - 1;
}

// Same-shape contract: controls must mirror the real request's type, series/point counts,
// y magnitude/decimals/sign and x kind — so a transcription channel that fails on this
// shape would also have failed on the real chart.
export function buildControlShape(spec) {
  let yMagnitude = -Infinity;
  let yDecimals = 0;
  let hasNegativeY = false;
  let allNumberX = true;

  for (const entry of spec.series) {
    for (const point of entry.points) {
      yMagnitude = Math.max(yMagnitude, Math.floor(Math.log10(Math.abs(point.y) || 1)));
      yDecimals = Math.max(yDecimals, decimalPlacesOf(point.y));
      if (point.y < 0) hasNegativeY = true;
      if (typeof point.x !== "number") allNumberX = false;
    }
  }

  return {
    type: spec.type,
    seriesCount: spec.series.length,
    pointCounts: spec.series.map((entry) => entry.points.length),
    yMagnitude: Number.isFinite(yMagnitude) ? yMagnitude : 0,
    yDecimals: Math.min(yDecimals, MAX_Y_DECIMALS),
    hasNegativeY,
    xKind: allNumberX ? "number" : "string",
  };
}

// ── 4. shape → synthetic ground-truth dataset ────────────────────────────────

// "样本A".."样本Z", then "样本AA".. — unique by construction within a series.
function controlXLabel(pointIndex) {
  let letters = "";
  let remaining = pointIndex;
  do {
    letters = String.fromCharCode(65 + (remaining % 26)) + letters;
    remaining = Math.floor(remaining / 26) - 1;
  } while (remaining >= 0);
  return `样本${letters}`;
}

// rng is an injectable 0..1 random function (defaults to Math.random) so tests can seed it.
export function generateControlDataset(shape, index, rng = Math.random) {
  const lower = Math.pow(10, shape.yMagnitude);
  const upper = Math.pow(10, shape.yMagnitude + 1);
  // Tiny magnitudes (|y| < 1e-4) need MORE decimals than the displayed cap, or toFixed would
  // collapse every control y to 0. For yMagnitude >= 0 this is exactly shape.yDecimals.
  // 100 is toFixed's hard upper limit.
  const effectiveDecimals = Math.min(100, Math.max(shape.yDecimals, -shape.yMagnitude));
  const step = Math.pow(10, -effectiveDecimals);

  const series = [];
  for (let seriesIndex = 0; seriesIndex < shape.seriesCount; seriesIndex += 1) {
    const pointCount = shape.pointCounts[seriesIndex];
    const points = [];
    for (let pointIndex = 0; pointIndex < pointCount; pointIndex += 1) {
      const x = shape.xKind === "number" ? pointIndex + 1 : controlXLabel(pointIndex);
      let y = Number((lower + rng() * (upper - lower)).toFixed(effectiveDecimals));
      if (y >= upper) y = Number((upper - step).toFixed(effectiveDecimals)); // rounding crossed the bound
      if (shape.hasNegativeY && rng() < 0.5) y = -y;
      points.push({ x, y });
    }
    series.push({ name: `对照线${seriesIndex + 1}`, points });
  }

  return { title: `对照样本${index + 1}`, series };
}

// ── 5. dataset → user-style control message ──────────────────────────────────

// Must read like a normal composer request — the LLM cannot tell it is a control.
// Every number is embedded verbatim; multi-series requests name each line.
export function buildControlMessage(dataset, type) {
  const typeLabel = TYPE_LABELS[type] || "图表";
  const body = dataset.series.length === 1
    ? formatPointList(dataset.series[0].points)
    : dataset.series.map((entry) => `${entry.name}: ${formatPointList(entry.points)}`).join("; ");
  return `用${typeLabel}展示${dataset.title}: ${body}`;
}

// ── 6. the code judge ────────────────────────────────────────────────────────

// halfStep = half of the smallest displayed decimal step of the ground-truth dataset. The
// tolerance is the TIGHTER of relative epsilon and halfStep, so a last-decimal transcription
// slip fails at ANY magnitude (654321.09 vs 654321.08 is a fail, not float drift).
function yMatches(expected, actual, halfStep) {
  if (typeof actual !== "number" || !Number.isFinite(actual)) return false;
  if (expected === 0) return actual === 0; // exact for 0 — relative epsilon is undefined there
  return Math.abs(actual - expected) <= Math.min(Math.abs(expected) * Y_RELATIVE_EPSILON, halfStep);
}

// Compares the LLM-produced spec against the code-generated ground-truth dataset.
// Returns { pass, mismatches: [zh strings] }. viz-master never self-certifies — this is
// the only verdict source for controls.
export function diffSpecAgainstDataset(spec, dataset) {
  const specSeries =
    spec && typeof spec === "object" && !Array.isArray(spec) && Array.isArray(spec.series)
      ? spec.series
      : null;
  if (!specSeries || specSeries.length === 0) {
    return { pass: false, mismatches: ["no spec produced"] };
  }

  const mismatches = [];
  if (specSeries.length !== dataset.series.length) {
    mismatches.push(`系列数: 期望 ${dataset.series.length}, 实得 ${specSeries.length}`);
  }

  // Max decimal places across the ground-truth dataset → the displayed step the controls were
  // generated at. yMatches tightens its tolerance to half of that step (see yMatches).
  const datasetDecimals = dataset.series.reduce(
    (outer, entry) => entry.points.reduce((inner, point) => Math.max(inner, decimalPlacesOf(point.y)), outer),
    0,
  );
  const halfStep = 0.5 * Math.pow(10, -datasetDecimals);

  // Pair dataset series → spec series: by trimmed name first (the LLM may reorder),
  // leftovers by index. Single-series control messages do not name the series, so a
  // differing name alone is not a mismatch — data fidelity is what is judged.
  const usedSpec = new Set();
  const matched = new Array(dataset.series.length).fill(null);
  dataset.series.forEach((dsSeries, dsIndex) => {
    const wanted = normalizeString(dsSeries.name);
    if (!wanted) return;
    const found = specSeries.findIndex(
      (entry, specIndex) => !usedSpec.has(specIndex) && normalizeString(entry?.name) === wanted,
    );
    if (found !== -1) {
      usedSpec.add(found);
      matched[dsIndex] = specSeries[found];
    }
  });
  dataset.series.forEach((dsSeries, dsIndex) => {
    if (matched[dsIndex]) return;
    const fallback = !usedSpec.has(dsIndex) && specSeries[dsIndex]
      ? dsIndex
      : specSeries.findIndex((entry, specIndex) => !usedSpec.has(specIndex) && entry);
    if (fallback !== -1 && fallback !== null && specSeries[fallback]) {
      usedSpec.add(fallback);
      matched[dsIndex] = specSeries[fallback];
    }
  });

  dataset.series.forEach((dsSeries, dsIndex) => {
    const target = matched[dsIndex];
    const prefix = dataset.series.length > 1 ? `${dsSeries.name}/` : "";
    if (!target) {
      mismatches.push(`${dsSeries.name}: 缺少整个系列`);
      return;
    }

    // Order-insensitive compare keyed by String(x).trim(); dataset xs are unique by construction.
    // A duplicated x in the transcribed spec is itself a transcription defect — flag it instead
    // of silently letting the later point overwrite the earlier one.
    const specPoints = new Map();
    for (const point of Array.isArray(target.points) ? target.points : []) {
      const key = String(point?.x).trim();
      if (specPoints.has(key)) {
        mismatches.push(`${prefix}${key}: 重复数据点`);
        continue;
      }
      specPoints.set(key, point?.y);
    }
    for (const point of dsSeries.points) {
      const key = String(point.x).trim();
      if (!specPoints.has(key)) {
        mismatches.push(`${prefix}${key}: 缺少数据点 (期望 ${point.y})`);
        continue;
      }
      const actual = specPoints.get(key);
      specPoints.delete(key);
      if (!yMatches(point.y, actual, halfStep)) {
        mismatches.push(`${prefix}${key}: 期望 ${point.y}, 实得 ${actual}`);
      }
    }
    for (const [key, actual] of specPoints) {
      mismatches.push(`${prefix}${key}: 多出数据点 (实得 ${actual})`);
    }
  });

  return { pass: mismatches.length === 0, mismatches };
}
