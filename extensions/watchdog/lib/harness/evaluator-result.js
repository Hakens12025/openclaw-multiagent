/**
 * evaluator-result.js — EvaluationResult 独立可溯源对象
 *
 * 明确 reviewerResult → EvaluationResult 的派生关系。
 * 每个 EvaluationResult 带唯一 id，记录来源 reviewerResultId/harnessRunId，
 * 供 deriveDecision 消费，代替 reviewerResult 直接冒充评估层。
 */

import { normalizeFiniteNumber, normalizeString } from "../core/normalize.js";

const VALID_VERDICTS = new Set(["pass", "fail", "inconclusive", "improved", "regressed"]);
const VALID_HINTS = new Set(["continue", "rework", "conclude", "pause"]);

function makeId() {
  return `er-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

export function buildEvaluationResult({
  reviewerResultId = null,
  harnessRunId = null,
  verdict = "inconclusive",
  continueHint = null,
  testsPassed = null,
  score = null,
  round = null,
  ts = Date.now(),
} = {}) {
  const id = makeId();
  const normalizedVerdict = (() => {
    const v = normalizeString(verdict)?.toLowerCase();
    return v && VALID_VERDICTS.has(v) ? v : "inconclusive";
  })();
  const normalizedHint = (() => {
    const h = normalizeString(continueHint)?.toLowerCase();
    return h && VALID_HINTS.has(h) ? h : null;
  })();

  return {
    id,
    evaluationResultId: id,
    reviewerResultId: normalizeString(reviewerResultId) || null,
    harnessRunId: normalizeString(harnessRunId) || null,
    verdict: normalizedVerdict,
    continueHint: normalizedHint,
    testsPassed: typeof testsPassed === "boolean" ? testsPassed : null,
    score: normalizeFiniteNumber(score, null),
    round: Number.isFinite(round) && round > 0 ? round : null,
    ts: Number.isFinite(ts) ? ts : Date.now(),
  };
}
