/**
 * dashboard-chart-render.test.js — pure unit tests for renderChartSvg.
 *
 * renderChartSvg returns an SVG **string** (not a DOM node), so these tests run under
 * plain node:test with no DOM. The shared esc() helper falls back to string-replace when
 * `document` is undefined, so we import the real renderer without mocking.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { renderChartSvg } from '../dashboard-chart-render.js';

const lineSpec = {
  version: 1,
  id: 'cpu',
  label: 'CPU',
  type: 'line',
  title: 'CPU & RAM <load>',
  series: [{ name: 's1', points: [{ x: 'a', y: 1 }, { x: 'b', y: 4 }, { x: 'c', y: 2 }] }],
  axes: { x: { label: 'time' }, y: { label: 'pct' } },
};

const barSpec = {
  version: 1,
  id: 'bars',
  type: 'bar',
  title: 'Bars',
  series: [{ name: 's1', points: [{ x: 'q1', y: 3 }, { x: 'q2', y: 7 }] }],
};

const pieSpec = {
  version: 1,
  id: 'pie',
  type: 'pie',
  title: 'Pie',
  series: [{ name: 's1', points: [{ x: 'a', y: 2 }, { x: 'b', y: 3 }, { x: 'c', y: 5 }] }],
};

test('line spec renders a polyline, axes, and the escaped title', () => {
  const svg = renderChartSvg(lineSpec);
  assert.ok(svg.startsWith('<svg class="chart-svg"'), 'root is chart-svg');
  assert.match(svg, /<polyline class="chart-line"/);
  assert.match(svg, /<line class="chart-axis"/);
  // Title is escaped: '<load>' -> '&lt;load&gt;', raw angle brackets must not survive.
  assert.ok(svg.includes('CPU &amp; RAM &lt;load&gt;'), 'escaped title present');
  assert.ok(!svg.includes('CPU & RAM <load>'), 'raw unescaped title absent');
});

test('bar spec renders one rect per point', () => {
  const svg = renderChartSvg(barSpec);
  assert.match(svg, /<rect class="chart-bar"/);
  const rectCount = (svg.match(/<rect class="chart-bar"/g) || []).length;
  assert.equal(rectCount, 2, 'one rect per data point');
});

test('pie spec renders path arcs', () => {
  const svg = renderChartSvg(pieSpec);
  assert.match(svg, /<path class="chart-pie-slice"/);
  const sliceCount = (svg.match(/<path class="chart-pie-slice"/g) || []).length;
  assert.equal(sliceCount, 3, 'one slice per series[0] point');
});

test('spec-derived text is escaped — no raw <script> reaches the string', () => {
  const xssSpec = {
    version: 1,
    id: 'xss',
    type: 'line',
    title: '<script>x',
    series: [{ name: 's', points: [{ x: '<script>x', y: 1 }, { x: 'ok', y: 2 }] }],
  };
  const svg = renderChartSvg(xssSpec);
  assert.ok(svg.includes('&lt;script&gt;x'), 'escaped form present');
  assert.ok(!svg.includes('<script>x'), 'raw <script> must NOT be present');
});
