/**
 * soft-guidance.js — 软管反逼：给 softGuided 段产出结构建议模板
 *
 * 设计来源（备忘录78 §5.2 软管）：softGuided 段「需要稳定表达，但仍允许策略弹性」
 * ——要结构但不强制（不是 gate 卡关）。normalizer 类拼图块对 softGuided 段产出
 * 「建议模板」（如 memo/handoff/findings/score 的结构提示），放进 HarnessRun evidence
 * 供下游/agent 参考。**产建议，不拒绝**（不像 gate 卡关）。
 *
 * harness 红线：只产证据/建议，绝不碰 graph/loop/delivery/commit。
 */

import { normalizeString } from "../core/normalize.js";

// 已知 softGuided 段 → 结构建议模板（字段提示）。未列入的走 generic 兜底。
// 模板是「建议的结构字段」，agent 可参考但不强制（软管）。
const SOFT_GUIDANCE_TEMPLATES = Object.freeze({
  change_summary: ["what_changed", "why", "files_touched", "risk"],
  handoff_note: ["context", "done", "pending", "next_owner_hint"],
  structured_handoff: ["context", "done", "pending", "next_owner_hint"],
  stage_handoff: ["stage", "context", "done", "pending"],
  experiment_memo: ["hypothesis", "setup", "observation", "conclusion"],
  stage_summary: ["stage", "outcome", "evidence_refs"],
  verdict_summary: ["verdict", "rationale", "key_evidence"],
  score_explanation: ["score", "criteria", "rationale"],
  error_list: ["category", "severity", "message", "evidence_ref"],
});

// 段名 → 关键词 → 兜底模板（弱匹配，让未登记的 soft 段也有结构提示）。
function inferTemplate(segment) {
  const seg = segment.toLowerCase();
  if (seg.includes("summary")) return ["outcome", "rationale", "evidence_refs"];
  if (seg.includes("handoff")) return ["context", "done", "pending", "next_owner_hint"];
  if (seg.includes("memo")) return ["hypothesis", "observation", "conclusion"];
  if (seg.includes("finding") || seg.includes("error")) return ["category", "severity", "message"];
  if (seg.includes("score")) return ["score", "criteria", "rationale"];
  // 通用兜底：要点 + 依据 + 证据引用（要结构但不强制）
  return ["points", "rationale", "evidence_refs"];
}

/**
 * 对 Run-Shape Map 的 softGuided 段产出结构建议。
 * 每段 → { segment, kind:'soft_structure_suggestion', recommendedFields, enforced:false }。
 * enforced:false 表明这是软管建议（参考），不是 gate 卡关。
 *
 * @param {{ softGuided?:string[] }} runShapeMap
 * @returns {Array<{ segment:string, kind:string, recommendedFields:string[], enforced:boolean }>}
 */
export function buildSoftGuidanceSuggestions(runShapeMap) {
  const softSegments = (runShapeMap && Array.isArray(runShapeMap.softGuided))
    ? runShapeMap.softGuided
    : [];
  const suggestions = [];
  const seen = new Set();
  for (const raw of softSegments) {
    const segment = normalizeString(raw);
    if (!segment || seen.has(segment)) continue;
    seen.add(segment);
    const recommendedFields = SOFT_GUIDANCE_TEMPLATES[segment] || inferTemplate(segment);
    suggestions.push({
      segment,
      kind: "soft_structure_suggestion",
      recommendedFields: [...recommendedFields],
      enforced: false, // 软管：要结构但不强制
    });
  }
  return suggestions;
}
