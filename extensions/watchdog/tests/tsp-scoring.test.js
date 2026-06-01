import test from "node:test";
import assert from "node:assert/strict";

import {
  KNOWN_OPTIMAL_TOUR,
  NEAREST_NEIGHBOR_BASELINE,
  TSP_POINT_COUNT,
} from "../lib/formal-runtime/tsp/tsp-task.js";
import {
  parseTourFromOutput,
  validateTour,
  tourLength,
  scoreTsp,
  scoreTspOutput,
} from "../lib/formal-runtime/tsp/tsp-scoring.js";

const NEAREST_NEIGHBOR_TOUR = [0, 13, 1, 14, 7, 11, 6, 8, 10, 5, 4, 9, 3, 12, 2, 0];
const INDEX_ORDER_TOUR = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 0];

test("optimal tour scores exactly 100 and beats the nearest-neighbor baseline", () => {
  const result = scoreTsp(KNOWN_OPTIMAL_TOUR);
  assert.equal(result.valid, true);
  assert.equal(result.score, 100);
  assert.equal(result.ratio, 1);
  assert.equal(result.beatsNearestNeighbor, true);
});

test("nearest-neighbor baseline tour scores ~91 and does not beat itself", () => {
  const result = scoreTsp(NEAREST_NEIGHBOR_TOUR);
  assert.equal(result.valid, true);
  assert.ok(result.score > 90 && result.score < 92, `score ${result.score} 应在 (90,92)`);
  // 长度恰等于基线 → 不算"击败"基线（严格小于才算）
  assert.equal(result.beatsNearestNeighbor, false);
  assert.equal(Math.round(result.length), Math.round(NEAREST_NEIGHBOR_BASELINE));
});

test("a 2x-optimal tour (index order) clamps to 0", () => {
  const result = scoreTsp(INDEX_ORDER_TOUR);
  assert.equal(result.valid, true);
  assert.equal(result.score, 0);
  assert.ok(result.ratio >= 2, `ratio ${result.ratio} 应 >= 2`);
});

test("tourLength is monotonic: optimal < nearest-neighbor < index-order", () => {
  assert.ok(tourLength(KNOWN_OPTIMAL_TOUR) < tourLength(NEAREST_NEIGHBOR_TOUR));
  assert.ok(tourLength(NEAREST_NEIGHBOR_TOUR) < tourLength(INDEX_ORDER_TOUR));
});

test("validateTour rejects wrong length", () => {
  const r = validateTour([0, 1, 2, 0]);
  assert.equal(r.valid, false);
  assert.match(r.reason, /长度/);
});

test("validateTour rejects open tour (not returning to start)", () => {
  const open = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 7];
  const r = validateTour(open);
  assert.equal(r.valid, false);
  assert.match(r.reason, /首尾/);
});

test("validateTour rejects duplicate city", () => {
  const dup = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 1, 0];
  const r = validateTour(dup);
  assert.equal(r.valid, false);
  assert.match(r.reason, /重复/);
});

test("validateTour rejects out-of-range city", () => {
  const oob = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 99, 0];
  const r = validateTour(oob);
  assert.equal(r.valid, false);
  assert.match(r.reason, /越界/);
});

test("validateTour accepts a full valid permutation", () => {
  assert.equal(validateTour(KNOWN_OPTIMAL_TOUR).valid, true);
  assert.equal(validateTour(INDEX_ORDER_TOUR).valid, true);
});

test("parseTourFromOutput extracts a TOUR marker into a numeric array", () => {
  const text = "分析后得到最终路线如下：\nTOUR: 0 -> 5 -> 3 -> 11 -> 0\n完成。";
  assert.deepEqual(parseTourFromOutput(text), [0, 5, 3, 11, 0]);
});

test("parseTourFromOutput takes the LAST TOUR marker when multiple appear", () => {
  const text = "初版 TOUR: 0 -> 1 -> 2 -> 0\n改进后 TOUR: 0 -> 2 -> 1 -> 0\n";
  assert.deepEqual(parseTourFromOutput(text), [0, 2, 1, 0]);
});

test("parseTourFromOutput returns null when no marker present", () => {
  assert.equal(parseTourFromOutput("没有路线标记的普通文本"), null);
  assert.equal(parseTourFromOutput(""), null);
  assert.equal(parseTourFromOutput(null), null);
});

test("scoreTspOutput end-to-end: optimal tour text scores 100", () => {
  const text = `最终结论：\nTOUR: ${KNOWN_OPTIMAL_TOUR.join(" -> ")}\n`;
  const result = scoreTspOutput(text);
  assert.equal(result.valid, true);
  assert.equal(result.score, 100);
  assert.deepEqual(result.tour, KNOWN_OPTIMAL_TOUR);
});

test("scoreTspOutput end-to-end: missing marker yields invalid zero score", () => {
  const result = scoreTspOutput("我觉得最优路线挺短的，但忘了写出来");
  assert.equal(result.valid, false);
  assert.equal(result.score, 0);
  assert.equal(result.tour, null);
});

test("TSP_POINT_COUNT is the expected fixed 15", () => {
  assert.equal(TSP_POINT_COUNT, 15);
});
