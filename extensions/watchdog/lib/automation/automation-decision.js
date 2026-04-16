import { normalizeRecord, normalizeString, normalizePositiveInteger, normalizeFiniteNumber } from "../core/normalize.js";
import { CONTRACT_STATUS } from "../core/runtime-status.js";

// Re-export for consumers that import from this module
export { normalizePositiveInteger, normalizeFiniteNumber };

const VALID_ACTIONS = new Set(["continue", "rework", "conclude", "pause", "abandon"]);

const ACTION_FROM_DECISION = {
  continue: "continue",
  completed: "conclude",
  paused: "pause",
  error: "abandon",
  idle: "continue",
};

const FAILURE_CLASS_STRATEGIES = {
  timeout: "increase_timeout_or_simplify_task",
  awaiting_input: "provide_missing_input_then_resume",
  cancelled: "review_cancellation_cause_before_retry",
  abandoned: "reassess_feasibility_before_retry",
  failed: "analyze_failure_and_retry_with_fixes",
  review_rejected: "address_review_feedback_and_resubmit",
};

export function buildNextWakeAt(spec, now = Date.now()) {
  const cooldownSeconds = normalizePositiveInteger(spec?.wakePolicy?.cooldownSeconds, 300);
  return now + (cooldownSeconds * 1000);
}

export function computeImprovementState(spec, runtime, score, artifact, round) {
  const governance = normalizeRecord(spec?.governance, {});
  const currentBestScore = normalizeFiniteNumber(runtime?.bestScore, null);
  const minImprovement = normalizeFiniteNumber(governance.minImprovement, 0) || 0;
  const normalizedScore = normalizeFiniteNumber(score, null);
  const improved = normalizedScore != null
    && (currentBestScore == null || normalizedScore > (currentBestScore + minImprovement));

  return {
    improved,
    bestScore: improved ? normalizedScore : currentBestScore,
    bestRound: improved ? round : runtime?.bestRound ?? null,
    bestArtifact: improved ? (artifact || runtime?.bestArtifact || null) : (runtime?.bestArtifact || null),
    lastScore: normalizedScore,
    noImprovementStreak: normalizedScore == null
      ? normalizePositiveInteger(runtime?.noImprovementStreak, 0)
      : (improved ? 0 : normalizePositiveInteger(runtime?.noImprovementStreak, 0) + 1),
  };
}

function buildReworkGuidance(reviewerResult) {
  if (!reviewerResult) return null;

  const failureClass = normalizeString(reviewerResult.failureClass) || null;
  const reworkTarget = normalizeString(reviewerResult.reworkTarget) || null;
  const findings = Array.isArray(reviewerResult.findings) ? reviewerResult.findings : [];

  const actionableFindings = findings
    .filter((f) => f && f.message)
    .map((f) => ({
      category: normalizeString(f.category) || "general",
      severity: normalizeString(f.severity) || "info",
      message: normalizeString(f.message),
    }));

  if (!failureClass && !reworkTarget && actionableFindings.length === 0) return null;

  return {
    failureClass,
    reworkTarget,
    actionableFindings,
    strategy: (failureClass && FAILURE_CLASS_STRATEGIES[failureClass])
      || (actionableFindings.length > 0 ? "address_findings_and_retry" : "generic_retry"),
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
    // Preserve the runtime decision triplet consumed by automation state, summaries, and harness projections.
    decision: normalizeString(source.decision)?.toLowerCase() || action,
    status: normalizeString(source.status)?.toLowerCase() || null,
    nextWakeAt: Number.isFinite(source.nextWakeAt) ? source.nextWakeAt : null,
  };
}

export function deriveDecision(spec, runtime, {
  round,
  terminalStatus,
  score,
  noImprovementStreak,
  reviewerResult = null,
  improvementState = null,
}, now = Date.now()) {
  const wakePolicy = normalizeRecord(spec?.wakePolicy, {});
  const governance = normalizeRecord(spec?.governance, {});
  const mode = normalizeString(governance.mode)?.toLowerCase() || "continuous";
  const maxRounds = normalizePositiveInteger(governance.maxRounds, 0);
  const earlyStopPatience = normalizePositiveInteger(governance.earlyStopPatience, 0);
  const wakeOnResult = wakePolicy.onResult === true;
  const wakeOnFailure = wakePolicy.onFailure === true;

  const base = { round, score: normalizeFiniteNumber(score, null), ts: now };
  const verdict = reviewerResult?.verdict || null;
  const reworkGuidance = buildReworkGuidance(reviewerResult);

  function emit(decision, status, nextWakeAt, reason, action) {
    return normalizeAutomationDecision({
      action: action || ACTION_FROM_DECISION[decision] || "continue",
      decision,
      status,
      nextWakeAt,
      reason,
      verdict,
      improvementState: improvementState || null,
      reworkGuidance: (action === "rework" || (decision === "continue" && reason?.includes("rework")))
        ? reworkGuidance : null,
      ...base,
    });
  }

  if (spec?.enabled !== true) {
    return emit("paused", "paused", null, "automation_disabled", "pause");
  }

  if (terminalStatus === CONTRACT_STATUS.AWAITING_INPUT) {
    return emit("paused", "paused", null, "awaiting_input", "pause");
  }

  if (["once", "oneshot", "one_shot", "single"].includes(mode)) {
    return emit("completed", "completed", null, "single_round_mode", "conclude");
  }

  if (maxRounds > 0 && round >= maxRounds) {
    return emit("completed", "completed", null, "max_rounds", "conclude");
  }

  if (score != null && earlyStopPatience > 0 && noImprovementStreak >= earlyStopPatience) {
    return emit("completed", "completed", null, "early_stop_patience", "conclude");
  }

  if (reviewerResult && reviewerResult.verdict !== "inconclusive") {
    const hint = reviewerResult.continueHint;
    if (hint === "rework") {
      return emit("continue", "idle", buildNextWakeAt(spec, now), "reviewer_rework", "rework");
    }
    if (hint === "pause") {
      return emit("paused", "paused", null, "reviewer_pause", "pause");
    }
    if (hint === "conclude") {
      return emit("completed", "completed", null, "reviewer_conclude", "conclude");
    }
    if (reviewerResult.verdict === "fail" || reviewerResult.verdict === "regressed") {
      if (wakeOnFailure) {
        return emit("continue", "idle", buildNextWakeAt(spec, now), "reviewer_fail_retry", "rework");
      }
      return emit("error", "error", null, "reviewer_fail", "abandon");
    }
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
