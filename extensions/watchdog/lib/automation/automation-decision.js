import { createHash } from "node:crypto";

import { normalizeRecord, normalizeString, normalizePositiveInteger, normalizeFiniteNumber } from "../core/normalize.js";
import { CONTRACT_STATUS } from "../core/runtime-status.js";
// governance 唯一合流点（修死链 c）：所有 governance 读点经 resolveGovernance，
// 让 runtime.governanceSnapshot 真正被消费（非死对象）。
import { resolveGovernance } from "./resolve-governance.js";

// Re-export for consumers that import from this module
export { normalizePositiveInteger, normalizeFiniteNumber };

const VALID_ACTIONS = new Set(["continue", "rework", "conclude", "pause", "abandon"]);

// real[no-progress]：跨轮内容级 spin 守卫。execution-hard-stop-registry.js 已覆盖「同一轮内重复 tool-call」，
// maxRounds/earlyStopPatience 覆盖「轮数上限/分数无改善」，但都拦不住「连续多轮产出一字不差」——
// 这会在 maxRounds 很大时白烧 token（=钱）。此守卫在产物指纹连续 NO_PROGRESS_REPEAT_LIMIT 次
// 不变时提前收敛（金融级成本控制）。阈值=连续 2 次重复（产物跨 3 轮不变），保守避免单次巧合误触。
const NO_PROGRESS_REPEAT_LIMIT = 2;

// 产物内容指纹：仅对非空产物计算（空/过短由 handoff 校验 + fail 路径管，不参与 spin 检测）。
// 字符串原样、对象稳定序列化后 md5；与 execution-hard-stop-registry.js 的哈希策略一致。
function fingerprintArtifact(artifact) {
  if (artifact == null) return null;
  const text = typeof artifact === "string" ? artifact : JSON.stringify(artifact);
  if (!text || text.trim().length === 0) return null;
  return createHash("md5").update(text).digest("hex").slice(0, 16);
}

const ACTION_FROM_DECISION = {
  continue: "continue",
  completed: "conclude",
  paused: "pause",
  error: "abandon",
  idle: "continue",
};

export function buildNextWakeAt(spec, now = Date.now()) {
  const cooldownSeconds = normalizePositiveInteger(spec?.wakePolicy?.cooldownSeconds, 300);
  return now + (cooldownSeconds * 1000);
}

export function computeImprovementState(spec, runtime, score, artifact, round) {
  // governance 经合流点读：runtime.governanceSnapshot 有则覆盖 spec.minImprovement。
  const governance = resolveGovernance(spec, runtime);
  const currentBestScore = normalizeFiniteNumber(runtime?.bestScore, null);
  const minImprovement = governance.minImprovement;
  const normalizedScore = normalizeFiniteNumber(score, null);
  const improved = normalizedScore != null
    && (currentBestScore == null || normalizedScore > (currentBestScore + minImprovement));

  // 跨轮内容指纹 spin 检测：本轮非空产物指纹 === 上轮 → repeatStreak 累加，否则归零。
  // 空产物 → 指纹 null → 不参与（streak 归零），交由 handoff/fail 路径处理。
  const artifactFingerprint = fingerprintArtifact(artifact);
  const priorFingerprint = normalizeString(runtime?.lastArtifactFingerprint) || null;
  const repeatStreak = (artifactFingerprint && artifactFingerprint === priorFingerprint)
    ? normalizePositiveInteger(runtime?.repeatStreak, 0) + 1
    : 0;

  return {
    improved,
    bestScore: improved ? normalizedScore : currentBestScore,
    bestRound: improved ? round : runtime?.bestRound ?? null,
    bestArtifact: improved ? (artifact || runtime?.bestArtifact || null) : (runtime?.bestArtifact || null),
    lastScore: normalizedScore,
    // 跨轮 spin 检测状态（落 runtime，下一轮经 computeImprovementState 读 priorFingerprint）。
    lastArtifactFingerprint: artifactFingerprint,
    repeatStreak,
    // real[22]：earlyStopPatience 度量「连续无改善的轮数」，与是否有数值分无关。
    // 无数值分（qualitative loop）时 improved 已为 false（见上 line 33-34），自然累加，
    // 不再把 streak 钉死在 0（否则 earlyStopPatience 对 score-less automation 永远失效）。
    noImprovementStreak: improved
      ? 0
      : normalizePositiveInteger(runtime?.noImprovementStreak, 0) + 1,
  };
}

export function normalizeAutomationDecision(raw) {
  const source = normalizeRecord(raw, null);
  if (!source) return null;

  const rawAction = normalizeString(source.action || source.decision)?.toLowerCase();
  const action = rawAction && VALID_ACTIONS.has(rawAction)
    ? rawAction
    : (ACTION_FROM_DECISION[normalizeString(source.decision)?.toLowerCase()] || "continue");

  return {
    action,
    reason: normalizeString(source.reason) || "unknown",
    round: normalizePositiveInteger(source.round, 0),
    score: normalizeFiniteNumber(source.score, null),
    verdict: normalizeString(source.verdict) || null,
    improvementState: normalizeRecord(source.improvementState, null),
    reworkGuidance: normalizeRecord(source.reworkGuidance, null),
    ts: Number.isFinite(source.ts) ? source.ts : Date.now(),
    // Preserve the runtime decision triplet consumed by automation state and summaries.
    decision: normalizeString(source.decision)?.toLowerCase() || action,
    status: normalizeString(source.status)?.toLowerCase() || null,
    nextWakeAt: Number.isFinite(source.nextWakeAt) ? source.nextWakeAt : null,
  };
}

// 评价臂已删（2026-08-26 死码清理）：evaluationResult 入参与 verdict/continueHint
// 分支随 harness 判定链全退役（v226）后生产恒不可达——唯一生产调用方
// automation-finalize.js 恒传 null。决策主干 = enabled/mode 门 + 指纹 spin 守卫 +
// 预算（maxRounds/earlyStopPatience）+ terminalStatus/wakePolicy。
export function deriveDecision(spec, runtime, {
  round,
  terminalStatus,
  score,
  noImprovementStreak,
  improvementState = null,
}, now = Date.now()) {
  const wakePolicy = normalizeRecord(spec?.wakePolicy, {});
  // governance 经合流点读：runtime.governanceSnapshot 覆盖 spec 后，决策真受 snapshot 影响。
  const governance = resolveGovernance(spec, runtime);
  const mode = governance.mode;
  const maxRounds = governance.maxRounds;
  const earlyStopPatience = governance.earlyStopPatience;
  const wakeOnResult = wakePolicy.onResult === true;
  const wakeOnFailure = wakePolicy.onFailure === true;

  const base = { round, score: normalizeFiniteNumber(score, null), ts: now };

  function emit(decision, status, nextWakeAt, reason, action) {
    return normalizeAutomationDecision({
      action: action || ACTION_FROM_DECISION[decision] || "continue",
      decision,
      status,
      nextWakeAt,
      reason,
      improvementState: improvementState || null,
      reworkGuidance: null,
      ...base,
    });
  }

  if (spec?.enabled !== true) {
    return emit("paused", "paused", null, "automation_disabled", "pause");
  }


  if (["once", "oneshot", "one_shot", "single"].includes(mode)) {
    return emit("completed", "completed", null, "single_round_mode", "conclude");
  }

  // real[no-progress]：跨轮内容级 spin —— 产物指纹连续 NO_PROGRESS_REPEAT_LIMIT 次不变 → 提前止损。
  // 重复 = 卡住但有效 → conclude。置于 maxRounds 之前：maxRounds 很大时本守卫更早收敛省 token。
  const repeatStreak = normalizePositiveInteger(improvementState?.repeatStreak, 0);
  if (NO_PROGRESS_REPEAT_LIMIT > 0 && repeatStreak >= NO_PROGRESS_REPEAT_LIMIT) {
    return emit("completed", "completed", null, "no_progress_repeat", "conclude");
  }

  if (maxRounds > 0 && round >= maxRounds) {
    return emit("completed", "completed", null, "max_rounds", "conclude");
  }

  // real[22]：不再要求数值分存在；streak 现对 qualitative loop 也会累加，knob 真正生效。
  if (earlyStopPatience > 0 && noImprovementStreak >= earlyStopPatience) {
    return emit("completed", "completed", null, "early_stop_patience", "conclude");
  }

  if (terminalStatus === CONTRACT_STATUS.FAILED && !wakeOnFailure) {
    return emit("error", "error", null, "round_failed", "abandon");
  }

  if (wakeOnResult || (terminalStatus === CONTRACT_STATUS.FAILED && wakeOnFailure)) {
    const reason = terminalStatus === CONTRACT_STATUS.FAILED ? "continue_on_failure" : "continue_on_result";
    return emit("continue", "idle", buildNextWakeAt(spec, now), reason, "continue");
  }

  return emit("idle", "idle", null, "terminal_idle", "continue");
}

export function buildRoundSummary({
  round,
  score,
  decision,
  status,
  artifact,
  summary,
  ts,
}) {
  return {
    round,
    score,
    decision,
    status,
    artifact,
    summary,
    ts,
  };
}
