// lib/runtime-mailbox-outbox-reviewer-verdict.js — reviewer verdict normalization

import {
  isResearcherAgent,
  isSpecializedExecutor,
  resolvePreferredExecutorAgentId,
} from "../agent/agent-identity.js";

export const VERDICT_MAP = {
  approve: { verdict: "pass", continueHint: "continue" },
  reject: { verdict: "fail", continueHint: "rework" },
  continue: { verdict: "pass", continueHint: "continue" },
  conclude: { verdict: "pass", continueHint: "conclude" },
  code_fix: { verdict: "fail", continueHint: "rework" },
  pivot: { verdict: "inconclusive", continueHint: "rework" },
  pass: { verdict: "pass", continueHint: "continue" },
  fail: { verdict: "fail", continueHint: "rework" },
  improved: { verdict: "improved", continueHint: "continue" },
  regressed: { verdict: "regressed", continueHint: "rework" },
};

export function normalizeReviewerDecision(parsed) {
  const rawVerdict = String(parsed?.verdict || parsed?.action || "").toLowerCase();
  const mapped = VERDICT_MAP[rawVerdict] || { verdict: "inconclusive", continueHint: "continue" };

  const feedback = [
    parsed?.code_feedback,
    parsed?.feedback,
    parsed?.round_summary,
  ].filter((v) => typeof v === "string" && v.trim()).join("\n")
    || `reviewer:${rawVerdict || "unknown"}`;

  const findings = (Array.isArray(parsed?.issues) ? parsed.issues : [])
    .concat(Array.isArray(parsed?.findings) ? parsed.findings : [])
    .map((issue) => ({
      category: issue?.category || "code_review",
      severity: issue?.severity || "warning",
      message: issue?.description || issue?.message || "review issue",
      evidence: issue?.evidence || issue?.line || null,
      artifactRef: issue?.artifactRef || null,
    }))
    .filter((f) => f.message);

  let reworkTarget = parsed?.rework_target || parsed?.reworkTarget || null;
  if (reworkTarget && !isSpecializedExecutor(reworkTarget) && !isResearcherAgent(reworkTarget)) {
    reworkTarget = resolvePreferredExecutorAgentId();
  }

  const deadEnds = Array.isArray(parsed?.dead_ends_to_add || parsed?.deadEnds)
    ? (parsed?.dead_ends_to_add || parsed?.deadEnds)
    : [];

  return {
    rawVerdict,
    feedback,
    findings,
    reworkTarget,
    deadEnds,
    score: typeof parsed?.score === "number" ? parsed.score : null,
    mapped,
  };
}

export function buildReviewerTransition(mapped, reworkTarget) {
  if (mapped.continueHint === "conclude") {
    return { kind: "conclude", reason: "evaluation_conclude" };
  }
  if (mapped.verdict === "fail" || mapped.verdict === "regressed" || mapped.continueHint === "rework") {
    return {
      kind: reworkTarget ? "advance" : "hold",
      targetStage: reworkTarget || null,
      reason: `evaluation_${mapped.continueHint || "rework"}`,
    };
  }
  return { kind: "follow_graph", reason: `evaluation_${mapped.continueHint || "continue"}` };
}
