/**
 * reviewer-result.js — Canonical ReviewerResult object
 *
 * Bridges HarnessRun → pipeline gate / automation decision / operator brain.
 * Every evaluation outcome (harness module, soft gate, review bridge, manual)
 * normalizes into this shape before downstream consumption.
 */

import { normalizeFiniteNumber, normalizeRecord, normalizeString } from "../core/normalize.js";

function clampConfidence(value) {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.min(1, value))
    : null;
}

const VALID_VERDICTS = new Set([
  "pass",
  "fail",
  "inconclusive",
  "improved",
  "regressed",
]);

const VALID_SOURCES = new Set([
  "harness_module",
  "soft_gate",
  "system_action_review_delivery",
  "manual",
]);

const VALID_CONTINUE_HINTS = new Set([
  "continue",
  "rework",
  "conclude",
  "pause",
]);

const VALID_SEVERITIES = new Set([
  "info",
  "warning",
  "error",
  "critical",
]);

function normalizeVerdict(value, fallback = "inconclusive") {
  const normalized = normalizeString(value)?.toLowerCase();
  return normalized && VALID_VERDICTS.has(normalized) ? normalized : fallback;
}

function normalizeSource(value, fallback = "manual") {
  const normalized = normalizeString(value)?.toLowerCase();
  return normalized && VALID_SOURCES.has(normalized) ? normalized : fallback;
}

function normalizeContinueHint(value) {
  const normalized = normalizeString(value)?.toLowerCase();
  return normalized && VALID_CONTINUE_HINTS.has(normalized) ? normalized : null;
}

function normalizeFinding(value) {
  const source = normalizeRecord(value, null);
  if (!source) return null;
  const message = normalizeString(source.message);
  if (!message) return null;
  const severity = normalizeString(source.severity)?.toLowerCase();
  return {
    category: normalizeString(source.category) || "general",
    severity: severity && VALID_SEVERITIES.has(severity) ? severity : "info",
    message,
    evidence: normalizeString(source.evidence) || null,
    artifactRef: normalizeString(source.artifactRef) || null,
    confidence: clampConfidence(source.confidence),
  };
}

export function buildReviewerResult({
  source = "manual",
  score = null,
  verdict = "inconclusive",
  findings = [],
  failureClass = null,
  artifactRef = null,
  reworkTarget = null,
  confidence = null,
  continueHint = null,
  round = null,
  contractId = null,
  pipelineId = null,
  loopId = null,
  ts = Date.now(),
} = {}) {
  return {
    source: normalizeSource(source),
    score: normalizeFiniteNumber(score, null),
    verdict: normalizeVerdict(verdict),
    findings: (Array.isArray(findings) ? findings : [])
      .map((f) => normalizeFinding(f))
      .filter(Boolean),
    confidence: clampConfidence(confidence),
    failureClass: normalizeString(failureClass) || null,
    artifactRef: normalizeString(artifactRef) || null,
    reworkTarget: normalizeString(reworkTarget) || null,
    continueHint: normalizeContinueHint(continueHint),
    round: Number.isFinite(round) && round > 0 ? round : null,
    contractId: normalizeString(contractId) || null,
    pipelineId: normalizeString(pipelineId) || null,
    loopId: normalizeString(loopId) || null,
    ts: Number.isFinite(ts) ? ts : Date.now(),
  };
}

export function normalizeReviewerResult(raw) {
  const source = normalizeRecord(raw, null);
  if (!source) return null;
  if (!source.verdict && !source.score && !source.source) return null;
  return buildReviewerResult(source);
}

export function isPassingReviewerResult(result) {
  if (!result) return false;
  const verdict = normalizeString(result.verdict)?.toLowerCase();
  return verdict === "pass" || verdict === "improved";
}

export function mergeReviewerResults(results) {
  const entries = (Array.isArray(results) ? results : [])
    .map((r) => normalizeReviewerResult(r))
    .filter(Boolean);
  if (entries.length === 0) return null;
  if (entries.length === 1) return entries[0];

  const allFindings = entries.flatMap((r) => r.findings || []);
  const scores = entries.map((r) => r.score).filter((s) => s != null);
  const avgScore = scores.length > 0
    ? scores.reduce((sum, s) => sum + s, 0) / scores.length
    : null;
  const confidences = entries.filter((r) => typeof r.confidence === "number");
  const avgConfidence = confidences.length > 0
    ? confidences.reduce((sum, r) => sum + r.confidence, 0) / confidences.length
    : null;

  const hasFail = entries.some((r) => r.verdict === "fail");
  const hasRegressed = entries.some((r) => r.verdict === "regressed");
  const hasPass = entries.some((r) => r.verdict === "pass");
  const hasImproved = entries.some((r) => r.verdict === "improved");

  let mergedVerdict = "inconclusive";
  if (hasFail) mergedVerdict = "fail";
  else if (hasRegressed) mergedVerdict = "regressed";
  else if (hasPass || hasImproved) mergedVerdict = hasImproved ? "improved" : "pass";

  const hints = entries.map((r) => r.continueHint).filter(Boolean);
  const mergedHint = hints.includes("rework") ? "rework"
    : hints.includes("pause") ? "pause"
      : hints.includes("conclude") ? "conclude"
        : hints.includes("continue") ? "continue"
          : null;

  const latest = entries.reduce((best, r) => (r.ts > best.ts ? r : best), entries[0]);

  return buildReviewerResult({
    source: latest.source,
    score: avgScore,
    confidence: avgConfidence,
    verdict: mergedVerdict,
    findings: allFindings,
    failureClass: entries.find((r) => r.failureClass)?.failureClass || null,
    artifactRef: latest.artifactRef,
    reworkTarget: entries.find((r) => r.reworkTarget)?.reworkTarget || null,
    continueHint: mergedHint,
    round: latest.round,
    contractId: latest.contractId,
    pipelineId: latest.pipelineId,
    loopId: latest.loopId,
    ts: latest.ts,
  });
}
