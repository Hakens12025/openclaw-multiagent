/**
 * harness-evidence-vocab.js — HarnessRun evidence/failure_class 词汇表（单一权威清单）
 *
 * P0 归一：把散在 harness-module-evidence.js(classifyFailure) /
 * harness-module-runner.js / automation-decision.js(FAILURE_CLASS_STRATEGIES) 的
 * failure_class 值与 evidence key 命名收成**单一权威常量**，各处引用此处，不再各写各的。
 *
 * 叶子模块（无依赖），避免循环引用。不改运行时行为，只把"散落的命名"收口。
 */

// ── failure_class 归一清单 ────────────────────────────────────────────────────
// 来源(producer): harness-module-evidence.js classifyFailure() —— 由终态 status/reason 推导。
// 消费(consumer): automation-decision.js FAILURE_CLASS_STRATEGIES —— 每类对应一条 rework 策略。
// classifyFailure 还可能回退到"原始 status 字符串"（兜底），故这是**已知归一类**清单，
// 不是封闭枚举：未列入的会以原始 status 透传（消费端 strategy 取不到则为 null）。
export const HARNESS_FAILURE_CLASS = Object.freeze({
  TIMEOUT: "timeout",
  AWAITING_INPUT: "awaiting_input",
  CANCELLED: "cancelled",
  ABANDONED: "abandoned",
  FAILED: "failed",
  REVIEW_REJECTED: "review_rejected",
});

// 已知归一 failure_class 值集合（供校验/文档；非封闭枚举，见上注释）。
export const KNOWN_HARNESS_FAILURE_CLASSES = Object.freeze([
  HARNESS_FAILURE_CLASS.TIMEOUT,
  HARNESS_FAILURE_CLASS.AWAITING_INPUT,
  HARNESS_FAILURE_CLASS.CANCELLED,
  HARNESS_FAILURE_CLASS.ABANDONED,
  HARNESS_FAILURE_CLASS.FAILED,
  HARNESS_FAILURE_CLASS.REVIEW_REJECTED,
]);

// failure_class → rework 策略（automation-decision 消费）。
// 注：每个 key 必须是 HARNESS_FAILURE_CLASS 之一；策略文本是给下一轮 dispatch 的内容提示。
export const FAILURE_CLASS_STRATEGIES = Object.freeze({
  [HARNESS_FAILURE_CLASS.TIMEOUT]: "increase_timeout_or_simplify_task",
  [HARNESS_FAILURE_CLASS.AWAITING_INPUT]: "provide_missing_input_then_resume",
  [HARNESS_FAILURE_CLASS.CANCELLED]: "review_cancellation_cause_before_retry",
  [HARNESS_FAILURE_CLASS.ABANDONED]: "reassess_feasibility_before_retry",
  [HARNESS_FAILURE_CLASS.FAILED]: "analyze_failure_and_retry_with_fixes",
  [HARNESS_FAILURE_CLASS.REVIEW_REJECTED]: "address_review_feedback_and_resubmit",
});

// ── evidence key 命名规范 ─────────────────────────────────────────────────────
// HarnessRun.moduleRuns[].evidence 是 normalizeRecord 后的自由 record（形状随 kind 而异），
// 但跨模块共享的 key 在此固定命名，使上层（尤其 P2 findings.artifactRef）有稳定吃法。
//
// 语义约定：
//   - FAILURE_CLASS: normalizer.failure 模块 evidence.failureClass —— 失败归类（见上清单）。
//   - ARTIFACT_REF : 产出件路径引用 key。**P2 的 findings.artifactRef 强依赖它**——
//                    findings.artifactRef 只能由代码从 HarnessRun evidence 的 artifact 路径
//                    提取（collector.artifact / gate.artifact 的 evidence.path），
//                    LLM 不得自填（红线5：findings.artifactRef 由代码提取）。
//   - ARTIFACT_PRESENT: 产出件是否存在（boolean）。
//   - TERMINAL_STATUS : 终态状态透传（用于 normalizer.failure 等）。
//   - TEST_SIGNAL     : gate.test 的测试信号 evidence（{status,signal,source}）。
export const HARNESS_EVIDENCE_KEY = Object.freeze({
  FAILURE_CLASS: "failureClass",
  ARTIFACT_REF: "path",
  ARTIFACT_PRESENT: "present",
  TERMINAL_STATUS: "terminalStatus",
  TEST_SIGNAL: "testSignal",
});
