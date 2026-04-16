import { buildPlanResponse } from "./operator/operator-plan.js";
import { normalizeString } from "./core/normalize.js";

export function buildOperatorAdviceFallback({
  requestText,
  error,
} = {}) {
  const message = normalizeString(error?.message) || "operator brain unavailable";
  return buildPlanResponse({
    intent: "advice_only",
    summary: "operator 建议",
    reply: "当前 operator brain 不可用，所以这次只返回保守建议，不再回退到手写业务 planner 伪造执行计划。",
    warnings: [
      `operator-brain 当前不可用：${message}`,
    ],
    limitations: [
      "当前 operator 采用 declarative planning；planner 不可用时只返回 advice_only，不再由 runtime 代替 agent 生成业务计划。",
      "如果你要继续执行系统改动，需要先恢复 operator brain，或直接走对应 admin surface。",
    ],
    assumptions: [],
    derived: {
      requestText: normalizeString(requestText) || null,
      plannerSource: "operator_runtime_fallback",
      fallbackMode: "advice_only_only",
      reason: "operator_brain_unavailable",
    },
    steps: [],
  });
}

export function buildOperatorInvalidPlanFallback({
  requestText,
  error,
  brainResult,
} = {}) {
  const message = normalizeString(error?.message) || "invalid operator plan";
  return buildPlanResponse({
    intent: "advice_only",
    summary: "operator 计划被平台拒绝",
    reply: "operator brain 返回了一份不符合平台约束的计划，所以这次不会执行，也不会伪造替代计划。",
    warnings: [
      `operator 计划校验失败：${message}`,
    ],
    limitations: [
      "当前 operator 只接受通过 surface 校验的 declarative plan；未注册 surface、缺失必填字段或非法 payload 会被平台直接拒绝。",
      "如果你要继续执行系统改动，需要修正 operator brain 的输出，或直接走对应 admin surface。",
    ],
    assumptions: [],
    derived: {
      requestText: normalizeString(requestText) || null,
      plannerSource: normalizeString(brainResult?.source) || "operator_brain_llm",
      plannerModel: normalizeString(brainResult?.plannerModel) || null,
      fallbackMode: "invalid_plan_advice_only",
      reason: "operator_plan_validation_failed",
    },
    steps: [],
  });
}
