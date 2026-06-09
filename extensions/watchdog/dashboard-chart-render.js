// dashboard-chart-render.js — Pure SVG string renderer for chart specs.
//
// renderChartSvg(spec, opts) -> SVG **string** (not a DOM node, so it is node-unit-testable).
// Colors/strokes are supplied by CSS via element classes (theme vars), never hardcoded here.
// All spec-derived text (titles, axis labels, series names) reaches innerHTML, so it is
// escaped with the shared esc() helper.
//
// Spec shape: see lib/viz/chart-spec-schema.js (validateChartSpec). Supported types:
//   line -> polyline through series points + x/y axis lines + a few axis labels
//   bar  -> one rect per point (series flattened in order)
//   pie  -> one path arc per point of series[0]

import { esc } from './dashboard-common.js';

// Inset so axes/labels are not clipped at the SVG edge.
const MARGIN = { top: 16, right: 16, bottom: 24, left: 28 };

function numericY(point) {
  return typeof point?.y === 'number' && Number.isFinite(point.y) ? point.y : 0;
}

// x may be number or string (categorical) — index gives a stable horizontal position either way.
function flattenPoints(series) {
  const out = [];
  for (const s of series) {
    if (!s || !Array.isArray(s.points)) continue;
    for (const p of s.points) out.push(p);
  }
  return out;
}

// Map a value range to a pixel range, guarding against a zero-width domain (single point).
function makeScale(min, max, pxLo, pxHi) {
  const span = max - min;
  if (!Number.isFinite(span) || span === 0) {
    const mid = (pxLo + pxHi) / 2;
    return () => mid;
  }
  return (v) => pxLo + ((v - min) / span) * (pxHi - pxLo);
}

function round(n) {
  return Math.round(n * 100) / 100;
}

function renderLine(spec, width, height) {
  const innerLeft = MARGIN.left;
  const innerRight = width - MARGIN.right;
  const innerTop = MARGIN.top;
  const innerBottom = height - MARGIN.bottom;

  const points = flattenPoints(spec.series);
  const ys = points.map(numericY);
  const yMin = Math.min(0, ...ys);
  const yMax = Math.max(0, ...ys, 1);
  const yScale = makeScale(yMin, yMax, innerBottom, innerTop);

  const parts = [];

  // Axes.
  parts.push(`<line class="chart-axis" x1="${innerLeft}" y1="${innerTop}" x2="${innerLeft}" y2="${innerBottom}" />`);
  parts.push(`<line class="chart-axis" x1="${innerLeft}" y1="${innerBottom}" x2="${innerRight}" y2="${innerBottom}" />`);

  // A few y-axis labels (min / mid / max) — derived numbers, but escaped for safety.
  const yTicks = [yMin, (yMin + yMax) / 2, yMax];
  for (const tick of yTicks) {
    const ty = round(yScale(tick));
    parts.push(`<text class="chart-label" x="${innerLeft - 4}" y="${ty}" text-anchor="end">${esc(round(tick))}</text>`);
  }

  // One polyline per series.
  for (const s of spec.series) {
    const pts = Array.isArray(s.points) ? s.points : [];
    const xScale = makeScale(0, Math.max(1, pts.length - 1), innerLeft, innerRight);
    const coords = pts
      .map((p, i) => `${round(xScale(i))},${round(yScale(numericY(p)))}`)
      .join(' ');
    if (coords) parts.push(`<polyline class="chart-line" points="${coords}" />`);
  }

  // A few x-axis labels from the first series points.
  const first = spec.series[0]?.points || [];
  const xScale = makeScale(0, Math.max(1, first.length - 1), innerLeft, innerRight);
  for (let i = 0; i < first.length; i += 1) {
    if (first.length > 6 && i % 2 !== 0) continue; // thin out dense axes
    const tx = round(xScale(i));
    parts.push(`<text class="chart-label" x="${tx}" y="${innerBottom + 14}" text-anchor="middle">${esc(first[i].x)}</text>`);
  }

  return parts.join('');
}

function renderBar(spec, width, height) {
  const innerLeft = MARGIN.left;
  const innerRight = width - MARGIN.right;
  const innerTop = MARGIN.top;
  const innerBottom = height - MARGIN.bottom;

  const points = flattenPoints(spec.series);
  const ys = points.map(numericY);
  const yMin = Math.min(0, ...ys);
  const yMax = Math.max(0, ...ys, 1);
  const yScale = makeScale(yMin, yMax, innerBottom, innerTop);
  const zeroY = round(yScale(0));

  const parts = [];
  parts.push(`<line class="chart-axis" x1="${innerLeft}" y1="${innerTop}" x2="${innerLeft}" y2="${innerBottom}" />`);
  parts.push(`<line class="chart-axis" x1="${innerLeft}" y1="${zeroY}" x2="${innerRight}" y2="${zeroY}" />`);

  const count = Math.max(1, points.length);
  const slot = (innerRight - innerLeft) / count;
  const barW = round(Math.max(1, slot * 0.7));
  const pad = (slot - barW) / 2;

  points.forEach((p, i) => {
    const x = round(innerLeft + i * slot + pad);
    const yVal = round(yScale(numericY(p)));
    const y = Math.min(yVal, zeroY);
    const h = round(Math.abs(zeroY - yVal));
    parts.push(`<rect class="chart-bar" x="${x}" y="${y}" width="${barW}" height="${h}" />`);
    // Category label under each bar (escaped — x may be a string).
    parts.push(`<text class="chart-label" x="${round(x + barW / 2)}" y="${innerBottom + 14}" text-anchor="middle">${esc(p.x)}</text>`);
  });

  return parts.join('');
}

function renderPie(spec, width, height) {
  const series0 = spec.series[0];
  const points = (series0 && Array.isArray(series0.points)) ? series0.points : [];
  const cx = width / 2;
  const cy = height / 2;
  const radius = round(Math.max(8, Math.min(width, height) / 2 - MARGIN.top));

  const total = points.reduce((sum, p) => sum + Math.abs(numericY(p)), 0);
  const parts = [];

  if (total <= 0) {
    // Degenerate (all-zero) data: draw the outline circle as a single full slice path.
    parts.push(`<path class="chart-pie-slice" d="M ${round(cx)} ${round(cy)} m ${-radius} 0 a ${radius} ${radius} 0 1 0 ${radius * 2} 0 a ${radius} ${radius} 0 1 0 ${-radius * 2} 0 Z" />`);
    return parts.join('');
  }

  let angle = -Math.PI / 2; // start at 12 o'clock
  for (const p of points) {
    const frac = Math.abs(numericY(p)) / total;
    if (frac <= 0) continue;
    const sweep = frac * Math.PI * 2;
    const end = angle + sweep;
    const x1 = round(cx + radius * Math.cos(angle));
    const y1 = round(cy + radius * Math.sin(angle));
    const x2 = round(cx + radius * Math.cos(end));
    const y2 = round(cy + radius * Math.sin(end));
    const largeArc = sweep > Math.PI ? 1 : 0;
    const d = frac >= 1
      // Single 100% slice: arc cannot draw a full circle, so use two half-arcs.
      ? `M ${round(cx)} ${round(cy)} m ${-radius} 0 a ${radius} ${radius} 0 1 1 ${radius * 2} 0 a ${radius} ${radius} 0 1 1 ${-radius * 2} 0 Z`
      : `M ${round(cx)} ${round(cy)} L ${x1} ${y1} A ${radius} ${radius} 0 ${largeArc} 1 ${x2} ${y2} Z`;
    parts.push(`<path class="chart-pie-slice" d="${d}" />`);
    angle = end;
  }

  return parts.join('');
}

const RENDERERS = { line: renderLine, bar: renderBar, pie: renderPie };

// Pure: given a (already-normalized) chart spec, return an escaped SVG string. No I/O, no deps
// beyond the shared esc() helper. Unknown types fall through to a line render.
export function renderChartSvg(spec, { width = 360, height = 220 } = {}) {
  const safeSpec = spec && typeof spec === 'object' ? spec : {};
  const series = Array.isArray(safeSpec.series) ? safeSpec.series : [];
  const w = Number.isFinite(safeSpec?.render?.width) ? safeSpec.render.width : width;
  const h = Number.isFinite(safeSpec?.render?.height) ? safeSpec.render.height : height;

  const renderer = RENDERERS[safeSpec.type] || RENDERERS.line;
  const body = series.length ? renderer({ ...safeSpec, series }, w, h) : '';

  const title = safeSpec.title || safeSpec.label || '';
  const titleEl = title
    ? `<text class="chart-label" x="${round(w / 2)}" y="12" text-anchor="middle">${esc(title)}</text>`
    : '';

  return `<svg class="chart-svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" `
    + `preserveAspectRatio="xMidYMid meet" role="img">${titleEl}${body}</svg>`;
}
