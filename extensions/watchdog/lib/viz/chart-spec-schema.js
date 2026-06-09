// chart-spec-schema.js — the declarative chart spec contract + validator. Pure (no I/O, no npm deps).
// A chart spec is a NON-truth control-plane artifact (sibling of knowledge-bases.json): it
// describes what a hand-rolled SVG renderer can draw, nothing more. The expressive ceiling is
// bounded deliberately — line/bar/pie, flat series of points, no live data wiring yet.
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
//     dataBinding: { mode: "static" },         // "sse" reserved, not yet validated as live
//     render: { prefer: "declarative", width?: number, height?: number }
//   }

import { normalizeString } from "../core/normalize.js";

// kebab-case slug, no path traversal, bounded length — mirrors skill-author SKILL_ID_PATTERN.
const CHART_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,48}$/;
const CHART_TYPES = Object.freeze(["line", "bar", "pie"]);

function normalizeAxis(axis) {
  const record = axis && typeof axis === "object" && !Array.isArray(axis) ? axis : {};
  return { label: normalizeString(record.label) ?? "" };
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

  const series = spec.series.map((entry, seriesIndex) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`chart spec "${id}": series[${seriesIndex}] must be an object`);
    }
    if (!Array.isArray(entry.points) || entry.points.length === 0) {
      throw new Error(`chart spec "${id}": series[${seriesIndex}] must have a non-empty points array`);
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
    dataBinding: { mode: "static" },
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

export { CHART_ID_PATTERN, CHART_TYPES };
