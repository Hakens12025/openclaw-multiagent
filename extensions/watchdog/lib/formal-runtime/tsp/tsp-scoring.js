// TSP 巡回的纯函数评分 —— 无 IO，可单测、可回归。
// 职责：解析 agent 产出里的巡回 → 校验合法性 → 算欧氏总长 → 对比已知最优给 0-100 分。
// 最终量化分由代码客观算出（这里），reviewer 的 verdict 只负责内容质量与 loop 早停/继续。

import {
  TSP_POINTS,
  TSP_POINT_COUNT,
  TSP_START_CITY,
  KNOWN_OPTIMAL,
  NEAREST_NEIGHBOR_BASELINE,
  SCORING_ZERO_RATIO,
} from "./tsp-task.js";

function dist(a, b) {
  const dx = TSP_POINTS[a][0] - TSP_POINTS[b][0];
  const dy = TSP_POINTS[a][1] - TSP_POINTS[b][1];
  return Math.hypot(dx, dy);
}

function round4(value) {
  return Math.round(value * 1e4) / 1e4;
}

// 从 agent 产出文本里解析最后一个 "TOUR: a -> b -> ... " 标记为城市编号数组。解析不到返回 null。
// 取最后一个标记（多轮/多次书写时以最终结论为准）。
export function parseTourFromOutput(text) {
  if (typeof text !== "string" || text.length === 0) return null;
  const matches = [...text.matchAll(/TOUR:\s*(\d+(?:\s*->\s*\d+)+)/gu)];
  if (matches.length === 0) return null;
  const sequence = matches[matches.length - 1][1]
    .split("->")
    .map((token) => Number.parseInt(token.trim(), 10));
  if (sequence.some((value) => !Number.isInteger(value))) return null;
  return sequence;
}

// 校验合法闭合巡回：长度 = 点数+1，首尾都是起点，中间恰好覆盖 0..n-1 各一次。
export function validateTour(tour) {
  if (!Array.isArray(tour) || tour.length !== TSP_POINT_COUNT + 1) {
    const actual = Array.isArray(tour) ? tour.length : "非数组";
    return { valid: false, reason: `巡回长度应为 ${TSP_POINT_COUNT + 1}（含首尾起点），实际 ${actual}` };
  }
  if (tour[0] !== TSP_START_CITY || tour[tour.length - 1] !== TSP_START_CITY) {
    return { valid: false, reason: `首尾必须都是起点 ${TSP_START_CITY}` };
  }
  const body = tour.slice(0, -1); // 去掉末尾回程，应为 0..n-1 的排列
  const seen = new Set();
  for (const city of body) {
    if (!Number.isInteger(city) || city < 0 || city >= TSP_POINT_COUNT) {
      return { valid: false, reason: `城市编号越界：${city}` };
    }
    if (seen.has(city)) {
      return { valid: false, reason: `城市重复访问：${city}` };
    }
    seen.add(city);
  }
  if (seen.size !== TSP_POINT_COUNT) {
    return { valid: false, reason: `未覆盖全部 ${TSP_POINT_COUNT} 城市，仅 ${seen.size}` };
  }
  return { valid: true, reason: null };
}

// 巡回欧氏总长。调用前应先 validateTour。
export function tourLength(tour) {
  let total = 0;
  for (let index = 0; index < tour.length - 1; index += 1) {
    total += dist(tour[index], tour[index + 1]);
  }
  return total;
}

// 评分：score = clamp(0,100, 100·(ZERO_RATIO - ratio)/(ZERO_RATIO - 1))，ratio = length/optimal。
// 最优(ratio=1)→100；2×最优(ratio=2)→0；非法巡回→0。
export function scoreTsp(tour) {
  const validation = validateTour(tour);
  if (!validation.valid) {
    return {
      valid: false,
      reason: validation.reason,
      score: 0,
      length: null,
      ratio: null,
      optimalityGap: null,
      beatsNearestNeighbor: false,
    };
  }
  const length = tourLength(tour);
  const ratio = length / KNOWN_OPTIMAL;
  const raw = (100 * (SCORING_ZERO_RATIO - ratio)) / (SCORING_ZERO_RATIO - 1);
  const score = Math.max(0, Math.min(100, round4(raw)));
  return {
    valid: true,
    reason: null,
    score,
    length: round4(length),
    ratio: round4(ratio),
    optimalityGap: round4(ratio - 1),
    beatsNearestNeighbor: length < NEAREST_NEIGHBOR_BASELINE,
  };
}

// 便捷：直接从 agent 产出文本算分（解析 + 评分一步到位）。
export function scoreTspOutput(text) {
  const tour = parseTourFromOutput(text);
  if (tour === null) {
    return {
      valid: false,
      reason: "产出中未找到可解析的 TOUR: 标记",
      score: 0,
      length: null,
      ratio: null,
      optimalityGap: null,
      beatsNearestNeighbor: false,
      tour: null,
    };
  }
  return { ...scoreTsp(tour), tour };
}
