/**
 * run-shape-map.js — Run-Shape Map：本轮执行塑形覆盖图（正式可校验对象）
 *
 * 设计来源（备忘录78 §四/§十.1、备忘录113）：大 harness 的真实样子是「一张本轮
 * 执行塑形覆盖图」——显式回答「哪些段 hardShaped / softGuided / freeform」。
 * 此前三层划分只散在 HarnessRun.coverage 的三个数组，无独立对象、无 schema。
 *
 * Run-Shape Map 是 coverage 的**正式对象化**（同一真值的 schema 化，不是第二份真值）：
 * 把 coverage 的 hard/soft/freeform 三层做成带 schema 的可校验对象，挂到 HarnessRun，
 * 供 normalize / dashboard 投影读取（写了必被读，红线4）。
 *
 * harness 红线：只表达执行塑形边界，绝不碰 graph/edge/loop 下一跳/replyTo/delivery/commit。
 */

import { uniqueStrings, normalizeString } from "../core/normalize.js";
import { getHarnessModuleCatalogEntry } from "./harness-module-catalog.js";

// 三层塑形等级（与 coverage 三数组一一对应）。
export const RUN_SHAPE_LAYER = Object.freeze({
  HARD: "hardShaped",
  SOFT: "softGuided",
  FREEFORM: "freeform",
});

export const VALID_RUN_SHAPE_LAYERS = Object.freeze([
  RUN_SHAPE_LAYER.HARD,
  RUN_SHAPE_LAYER.SOFT,
  RUN_SHAPE_LAYER.FREEFORM,
]);

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * 从 coverage（{hardShaped,softGuided,freeform} 字符串数组）构造 Run-Shape Map。
 * 三层去重；soft 去掉与 hard 重叠者、freeform 去掉与 hard/soft 重叠者（保持互斥，
 * 与 registry buildDisjointCoverage 同语义）。segments 是三层并集（本轮被塑形的段全集）。
 *
 * @param {{ hardShaped?:string[], softGuided?:string[], freeform?:string[] }} coverage
 * @returns {{
 *   hardShaped:string[], softGuided:string[], freeform:string[],
 *   segments:string[], counts:{hardShaped:number,softGuided:number,freeform:number,total:number},
 * }}
 */
export function buildRunShapeMap(coverage) {
  const source = isPlainObject(coverage) ? coverage : {};
  const hard = uniqueStrings(source.hardShaped);
  const hardSet = new Set(hard);
  const soft = uniqueStrings(source.softGuided).filter((s) => !hardSet.has(s));
  const softSet = new Set(soft);
  const free = uniqueStrings(source.freeform).filter((s) => !hardSet.has(s) && !softSet.has(s));
  const segments = [...hard, ...soft, ...free];

  return {
    hardShaped: hard,
    softGuided: soft,
    freeform: free,
    segments,
    counts: {
      hardShaped: hard.length,
      softGuided: soft.length,
      freeform: free.length,
      total: segments.length,
    },
  };
}

/**
 * 校验 Run-Shape Map 是否符合正式契约（P0 schema 风格）。
 * 必填: hardShaped/softGuided/freeform 三层均为字符串数组，且三层互斥（无重叠段）。
 *
 * @param {unknown} map
 * @returns {{ ok: boolean, problems: string[] }}
 */
export function validateRunShapeMap(map) {
  const problems = [];
  if (!isPlainObject(map)) {
    return { ok: false, problems: ["run-shape map must be a plain object"] };
  }

  const layers = {};
  for (const layer of VALID_RUN_SHAPE_LAYERS) {
    const value = map[layer];
    if (!Array.isArray(value)) {
      problems.push(`layer "${layer}" must be an array`);
      layers[layer] = [];
      continue;
    }
    const nonStrings = value.filter((item) => typeof item !== "string");
    if (nonStrings.length > 0) {
      problems.push(`layer "${layer}" must be an array of strings; found ${nonStrings.length} non-string item(s)`);
    }
    layers[layer] = value.filter((item) => typeof item === "string");
  }

  // 三层互斥：同一段不得跨层（否则塑形等级矛盾 → 假安全感）。
  const seen = new Map();
  for (const layer of VALID_RUN_SHAPE_LAYERS) {
    for (const seg of layers[layer]) {
      if (seen.has(seg)) {
        problems.push(`segment "${seg}" appears in both "${seen.get(seg)}" and "${layer}" (layers must be disjoint)`);
      } else {
        seen.set(seg, layer);
      }
    }
  }

  return { ok: problems.length === 0, problems };
}

/**
 * coverage 完整性校验（备忘录78 §7.1 消除假安全感）：
 * 若本轮 moduleRefs 引用的拼图块在 catalog 里声明了 hardShaped 段，但 Run-Shape Map
 * 的 hardShaped 层没显式声明这些段 → 报警（缺口）。说明本轮装了硬管模块，却没在
 * 覆盖图里如实标注 hard 段，会形成「以为硬控了其实没标」的假安全感。
 *
 * 设计为**非硬失败**：返回 { complete, missingHardSegments[], warnings[] }，由调用方
 * 决定 warn（不破坏现有跑通）。
 *
 * @param {object} runShapeMap  buildRunShapeMap 产出
 * @param {string[]} moduleRefs 本轮模块引用
 * @returns {{ complete:boolean, missingHardSegments:string[], warnings:string[] }}
 */
export function validateCoverageCompleteness(runShapeMap, moduleRefs) {
  const declaredHard = new Set(
    isPlainObject(runShapeMap) && Array.isArray(runShapeMap.hardShaped)
      ? runShapeMap.hardShaped.filter((s) => typeof s === "string")
      : [],
  );

  // 模块 catalog 声明的 hardShaped 段全集（本轮装了哪些硬管模块就该硬控哪些段）
  const moduleHardSegments = new Set();
  for (const ref of Array.isArray(moduleRefs) ? moduleRefs : []) {
    const moduleId = normalizeString(ref);
    if (!moduleId) continue;
    const entry = getHarnessModuleCatalogEntry(moduleId);
    for (const seg of Array.isArray(entry?.hardShaped) ? entry.hardShaped : []) {
      if (typeof seg === "string" && seg) moduleHardSegments.add(seg);
    }
  }

  const missingHardSegments = [...moduleHardSegments].filter((seg) => !declaredHard.has(seg));
  const warnings = missingHardSegments.length > 0
    ? [
        `coverage 缺口：${missingHardSegments.length} 个硬管段由模块声明但未在 RunShapeMap.hardShaped 标注`
        + `（消除假安全感）：[${missingHardSegments.join(", ")}]`,
      ]
    : [];

  return {
    complete: missingHardSegments.length === 0,
    missingHardSegments,
    warnings,
  };
}
