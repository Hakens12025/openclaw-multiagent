/**
 * finding-marker-parser.js — Extract [BLOCKING]/[SUGGESTION] markers from reviewer output
 *
 * Parses severity markers and evidence lines from markdown content,
 * producing structured findings compatible with ReviewerResult.
 *
 * Rule 12.2: agent writes content (markdown with markers), system extracts structure (findings).
 *
 * Format:
 *   [BLOCKING] summary text
 *   - evidence line 1
 *   - 置信度: 高/中/低
 *
 *   [SUGGESTION] summary text
 *   - evidence line 1
 */

import { normalizeString } from "./core/normalize.js";

const FINDING_MARKER_PATTERN = /^\[(BLOCKING|SUGGESTION|INFO)\]\s+(.+)$/;

const SEVERITY_MAP = {
  BLOCKING: "critical",
  SUGGESTION: "info",
  INFO: "info",
};

const CONFIDENCE_MAP = {
  "高": 0.9,
  "中": 0.6,
  "低": 0.3,
  "high": 0.9,
  "medium": 0.6,
  "low": 0.3,
};

function parseConfidence(text) {
  const trimmed = normalizeString(text);
  if (!trimmed) return null;
  for (const [key, value] of Object.entries(CONFIDENCE_MAP)) {
    if (trimmed.includes(key)) return value;
  }
  return null;
}

/**
 * Extract findings from markdown content.
 * Returns array of { severity, message, evidence[], confidence } objects.
 */
export function extractFindingMarkers(markdownContent) {
  if (typeof markdownContent !== "string") return [];

  const findings = [];
  const lines = markdownContent.split("\n");
  let current = null;

  for (const line of lines) {
    const trimmed = line.trim();

    // Check for finding marker
    const markerMatch = FINDING_MARKER_PATTERN.exec(trimmed);
    if (markerMatch) {
      if (current) findings.push(current);
      current = {
        severity: SEVERITY_MAP[markerMatch[1]] || "info",
        message: markerMatch[2].trim(),
        evidence: [],
        confidence: null,
      };
      continue;
    }

    // Inside a finding — collect evidence and confidence
    if (current && trimmed.startsWith("-")) {
      const detail = trimmed.slice(1).trim();

      // Check for confidence line
      const confMatch = /^置信度\s*[:：]\s*(.+)$/i.exec(detail) || /^confidence\s*[:：]\s*(.+)$/i.exec(detail);
      if (confMatch) {
        current.confidence = parseConfidence(confMatch[1]);
        continue;
      }

      // Otherwise it's evidence (capped to prevent unbounded growth from LLM output)
      if (detail && current.evidence.length < 20) {
        current.evidence.push(detail.slice(0, 500));
      }
      continue;
    }

    // Empty line or non-list line inside a finding — continue collecting
    // But a new heading or marker breaks the finding
    if (current && trimmed && !trimmed.startsWith("-") && !trimmed.startsWith("#")) {
      // Ignore non-list non-heading content inside finding block
      continue;
    }

    // A heading breaks the current finding
    if (current && trimmed.startsWith("#")) {
      findings.push(current);
      current = null;
    }
  }

  if (current) findings.push(current);

  return findings;
}

/**
 * Derive a simple verdict from findings.
 * Has any BLOCKING → "fail". All SUGGESTION/INFO → "pass".
 */
export function deriveVerdictFromFindings(findings) {
  if (!Array.isArray(findings) || findings.length === 0) return "pass";
  return findings.some((f) => f.severity === "critical") ? "fail" : "pass";
}

/**
 * Check if markdown contains any finding markers.
 */
export function hasFindingMarkers(markdownContent) {
  if (typeof markdownContent !== "string") return false;
  return FINDING_MARKER_PATTERN.test(markdownContent);
}
