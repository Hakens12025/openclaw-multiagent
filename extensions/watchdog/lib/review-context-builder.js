// lib/review-context-builder.js — ReviewContext: platform → harness → agent downward signal
//
// Assembles cross-round history, guard results, and artifact references
// into a single object injected into the reviewer's inbox.
// Data sources: automation runtime state (cross-round) + contract context (current round).

import { normalizeFiniteNumber, normalizeRecord, normalizeString } from "./core/normalize.js";
import { normalizeReviewerResult } from "./harness/reviewer-result.js";

export function buildReviewContext({
  automationRuntimeState = null,
  contractContext = null,
  artifacts = null,
} = {}) {
  const runtimeState = normalizeRecord(automationRuntimeState);
  const context = normalizeRecord(contractContext);

  const lastResult = normalizeReviewerResult(runtimeState.lastReviewerResult);

  return {
    round: normalizeFiniteNumber(context.round, null)
      || normalizeFiniteNumber(runtimeState.currentRound, null),
    previousVerdict: lastResult?.verdict || null,
    previousScore: normalizeFiniteNumber(runtimeState.lastScore, null),
    bestSoFarScore: normalizeFiniteNumber(runtimeState.bestScore, null),
    noImprovementStreak: normalizeFiniteNumber(runtimeState.noImprovementStreak, 0),
    artifacts: Array.isArray(artifacts)
      ? artifacts
          .map((a) => ({
            path: normalizeString(a?.path) || null,
            label: normalizeString(a?.label) || null,
          }))
          .filter((a) => a.path)
      : [],
    ts: Date.now(),
  };
}
