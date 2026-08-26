// chart-spec-schema.js — the declarative chart spec contract + validator. Pure (no I/O, no npm deps).
// A chart spec is a NON-truth control-plane artifact (sibling of knowledge-bases.json): it
// describes what a hand-rolled SVG renderer can draw, nothing more. The expressive ceiling is
// bounded deliberately — line/bar/pie, flat series of points; live data wiring is supported as
// dataBinding {mode:"sse"} (line-only polling of an inspect.* surface, see the shape below).
//
// Shape (version 1):
//   {
//     version: 1,
//     id: string,                       // kebab-case ^[a-z0-9][a-z0-9-]{1,48}$ (no path traversal)
//     label: string,                    // human-facing name (optional, defaults to id)
//     type: "line" | "bar" | "pie",
//     title: string,                    // chart heading (optional)
//     series: [
//       { name: string, points: [{ x: number|string, y: number }] }
//     ],
//     axes: { x: { label }, y: { label } },   // ignored when type === "pie"
//     dataBinding:
//       { mode: "static" }                     // flat embedded series (default)
//       | { mode: "sse", binding: {            // live time series — line charts only
//           source: "inspect.*",               // an inspect surface id (kebab/dotted)
//           field?: "dot.path",                // dot path to a numeric scalar; omitted →
//                                               //   array result → its length, number result → itself
//           intervalMs?: number,               // poll cadence, default 25000, clamp 5000..300000
//           maxPoints?: number,                // ring-buffer length, default 30, clamp 5..200
//         } },
//     render: { prefer: "declarative", width?: number, height?: number }
//   }

import { normalizeString, normalizeFiniteNumber } from "../core/normalize.js";

// kebab-case slug, no path traversal, bounded length — mirrors skill-author SKILL_ID_PATTERN.
const CHART_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,48}$/;
const CHART_TYPES = Object.freeze(["line", "bar", "pie"]);
const DATA_BINDING_MODES = Object.freeze(["static", "sse"]);

// Embedded-series caps — bound the flat data a single spec may carry (and, downstream, the
// verify-stage control fan-out cost). All live charts.json entries sit far below these.
const STATIC_MAX_SERIES = 10;
const STATIC_MAX_POINTS_PER_SERIES = 200;

// sse binding.source must be an inspect surface id — full charset check, not just the prefix
// (all 34 live inspect surface ids match this pattern).
const SSE_SOURCE_PATTERN = /^inspect\.[a-z0-9_.-]+$/;

// SSE live-binding bounds — keep poll cadence sane and the ring buffer bounded.
const SSE_INTERVAL_DEFAULT_MS = 25000;
const SSE_INTERVAL_MIN_MS = 5000;
const SSE_INTERVAL_MAX_MS = 300000;
const SSE_MAXPOINTS_DEFAULT = 30;
const SSE_MAXPOINTS_MIN = 5;
const SSE_MAXPOINTS_MAX = 200;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function normalizeAxis(axis) {
  const record = axis && typeof axis === "object" && !Array.isArray(axis) ? axis : {};
  return { label: normalizeString(record.label) ?? "" };
}

// Pure: validates + normalizes dataBinding. Returns { mode: "static" } or
// { mode: "sse", binding: {...} }. Throws on contract violation. The caller has
// already validated chart `type`; we pass it in to enforce sse → line.
function normalizeDataBinding(dataBinding, id, type) {
  const record = dataBinding && typeof dataBinding === "object" && !Array.isArray(dataBinding) ? dataBinding : {};
  const mode = normalizeString(record.mode) ?? "static";
  if (!DATA_BINDING_MODES.includes(mode)) {
    throw new Error(`chart spec "${id}": dataBinding.mode must be one of ${DATA_BINDING_MODES.join("|")}: ${record.mode}`);
  }
  if (mode === "static") {
    return { mode: "static" };
  }

  // mode === "sse": live time series — only the line renderer plots a temporal axis.
  if (type !== "line") {
    throw new Error(`chart spec "${id}": dataBinding.mode "sse" requires type "line" (live data is a time series), got "${type}"`);
  }

  const bindingRecord = record.binding && typeof record.binding === "object" && !Array.isArray(record.binding) ? record.binding : null;
  if (!bindingRecord) {
    throw new Error(`chart spec "${id}": dataBinding.mode "sse" requires a binding object`);
  }

  const source = normalizeString(bindingRecord.source);
  if (!source || !SSE_SOURCE_PATTERN.test(source)) {
    throw new Error(`chart spec "${id}": dataBinding.binding.source must be a non-empty string starting with "inspect." and matching ${SSE_SOURCE_PATTERN}: ${bindingRecord.source}`);
  }

  const binding = { source };

  const field = normalizeString(bindingRecord.field);
  if (field) {
    binding.field = field;
  }

  const intervalMs = normalizeFiniteNumber(bindingRecord.intervalMs, SSE_INTERVAL_DEFAULT_MS);
  binding.intervalMs = Math.round(clamp(intervalMs, SSE_INTERVAL_MIN_MS, SSE_INTERVAL_MAX_MS));

  const maxPoints = normalizeFiniteNumber(bindingRecord.maxPoints, SSE_MAXPOINTS_DEFAULT);
  binding.maxPoints = Math.round(clamp(maxPoints, SSE_MAXPOINTS_MIN, SSE_MAXPOINTS_MAX));

  return { mode: "sse", binding };
}

// Pure: throws Error with a clear message on any contract violation; returns a normalized spec
// (defaults filled) on success. No I/O, no deps.
export function validateChartSpec(spec) {
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) {
    throw new Error("chart spec must be an object");
  }

  const id = normalizeString(spec.id);
  if (!id || !CHART_ID_PATTERN.test(id)) {
    throw new Error(`chart spec: invalid id (need kebab-case ^[a-z0-9][a-z0-9-]{1,48}$): ${spec.id}`);
  }

  const type = normalizeString(spec.type);
  if (!type || !CHART_TYPES.includes(type)) {
    throw new Error(`chart spec: type must be one of ${CHART_TYPES.join("|")}: ${spec.type}`);
  }

  if (!Array.isArray(spec.series) || spec.series.length === 0) {
    throw new Error(`chart spec "${id}": series must be a non-empty array`);
  }
  if (spec.series.length > STATIC_MAX_SERIES) {
    throw new Error(`chart spec "${id}": series must have at most ${STATIC_MAX_SERIES} entries, got ${spec.series.length}`);
  }

  const series = spec.series.map((entry, seriesIndex) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`chart spec "${id}": series[${seriesIndex}] must be an object`);
    }
    if (!Array.isArray(entry.points) || entry.points.length === 0) {
      throw new Error(`chart spec "${id}": series[${seriesIndex}] must have a non-empty points array`);
    }
    if (entry.points.length > STATIC_MAX_POINTS_PER_SERIES) {
      throw new Error(`chart spec "${id}": series[${seriesIndex}] must have at most ${STATIC_MAX_POINTS_PER_SERIES} points, got ${entry.points.length}`);
    }
    const points = entry.points.map((point, pointIndex) => {
      if (!point || typeof point !== "object" || Array.isArray(point)) {
        throw new Error(`chart spec "${id}": series[${seriesIndex}].points[${pointIndex}] must be an object`);
      }
      if (typeof point.y !== "number" || !Number.isFinite(point.y)) {
        throw new Error(`chart spec "${id}": series[${seriesIndex}].points[${pointIndex}] must have a numeric y`);
      }
      const x = typeof point.x === "number" && Number.isFinite(point.x) ? point.x : normalizeString(point.x);
      if (x === null) {
        throw new Error(`chart spec "${id}": series[${seriesIndex}].points[${pointIndex}] must have a number or string x`);
      }
      return { x, y: point.y };
    });
    return { name: normalizeString(entry.name) ?? `series-${seriesIndex + 1}`, points };
  });

  const axesRecord = spec.axes && typeof spec.axes === "object" && !Array.isArray(spec.axes) ? spec.axes : {};
  const renderRecord = spec.render && typeof spec.render === "object" && !Array.isArray(spec.render) ? spec.render : {};

  const normalized = {
    version: 1,
    id,
    label: normalizeString(spec.label) ?? id,
    type,
    title: normalizeString(spec.title) ?? "",
    series,
    axes: { x: normalizeAxis(axesRecord.x), y: normalizeAxis(axesRecord.y) },
    dataBinding: normalizeDataBinding(spec.dataBinding, id, type),
    render: { prefer: "declarative" },
  };

  if (typeof renderRecord.width === "number" && Number.isFinite(renderRecord.width)) {
    normalized.render.width = renderRecord.width;
  }
  if (typeof renderRecord.height === "number" && Number.isFinite(renderRecord.height)) {
    normalized.render.height = renderRecord.height;
  }

  return normalized;
}

export { CHART_ID_PATTERN, CHART_TYPES, STATIC_MAX_SERIES, STATIC_MAX_POINTS_PER_SERIES };
