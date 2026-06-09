// harness-composition.js — harness 组装连贯性校验（operator 授权强化 / B-v2 改）
//
// 纯函数、非抛式。返回 { problems: [{severity, code, reason, suggestion?}] }，全为「建议」级。
// 硬性情形已被上游处理：未解析模块 → normalizeHarnessSelection 返回 null；freeform(0 模块) → 合法。
// 因此此处只做软建议，帮 operator 组出「连贯/有用」的 harness，不阻断创建。
//
// 真实模块语义（见 harness-module-evaluators.js）：gate 从 collector 或 terminalSource 取证据，
// 故「有 gate 无 collector」是建议(info)非错误；「有模块但无 gate/guard」= 采集但从不判定 / 无约束(warn)。

import { getHarnessModuleCatalogEntry, resolveHarnessModuleCatalogId } from "./harness-module-catalog.js";

export function validateHarnessComposition(moduleRefs = []) {
  const ids = [...new Set(
    (Array.isArray(moduleRefs) ? moduleRefs : [])
      .map((ref) => resolveHarnessModuleCatalogId(ref))
      .filter(Boolean),
  )];
  const problems = [];

  // freeform（无模块）合法，无可建议。
  if (ids.length === 0) return { problems };

  const kinds = new Set(ids.map((id) => getHarnessModuleCatalogEntry(id)?.kind).filter(Boolean));
  const has = (id) => ids.includes(id);

  // 有模块但无 gate：采集/守卫但从不判定 pass/fail —— harness 失去质量门控意义。
  if (!kinds.has("gate")) {
    problems.push({
      severity: "warn",
      code: "no_gate",
      reason: "harness 含模块但无 gate：会采集/守卫但从不判定 pass/fail（失去质量门控）",
      suggestion: "harness:gate.test",
    });
  }

  // 有模块但无 guard：无预算/工具/作用域约束。
  if (!kinds.has("guard")) {
    problems.push({
      severity: "warn",
      code: "no_guard",
      reason: "harness 含模块但无 guard：无预算/工具/作用域约束（budget/tool_access/scope）",
      suggestion: "harness:guard.budget",
    });
  }

  // 有 gate 但无 collector：gate 可从 terminalSource 取证据，但加 collector 证据更全（建议级）。
  if (kinds.has("gate") && !kinds.has("collector")) {
    problems.push({
      severity: "info",
      code: "gate_without_collector",
      reason: "有 gate 但无 collector：gate 可从 terminalSource 取证据，加 collector.artifact/trace 证据更完整",
      suggestion: "harness:collector.artifact",
    });
  }

  // normalizer.eval_input 读 artifact 证据，但未含 collector.artifact（建议级）。
  if (has("harness:normalizer.eval_input") && !has("harness:collector.artifact")) {
    problems.push({
      severity: "info",
      code: "eval_input_without_artifact_collector",
      reason: "normalizer.eval_input 归一 artifact 证据，但未含 collector.artifact",
      suggestion: "harness:collector.artifact",
    });
  }

  return { problems };
}

// 是否有任何 warn 级问题（info 不算）。供需要「硬一点」判定的调用方使用。
export function hasHarnessCompositionWarnings(moduleRefs = []) {
  return validateHarnessComposition(moduleRefs).problems.some((p) => p.severity === "warn");
}
