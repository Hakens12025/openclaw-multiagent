/**
 * action-marker-parser.js — Extract [ACTION] markers from agent output markdown
 *
 * Runtime-owned system_action extraction from normal output markdown.
 * Agent writes [ACTION] markers in normal output, system extracts intent.
 *
 * Supported formats:
 *   [ACTION] {"type":"assign_task","params":{...}}   ← full JSON marker
 *   [ACTION] wake <agentId> — <reason>
 *   [ACTION] delegate <agentId> — <instruction>
 *   [ACTION] advance <nextStage> — <reason>
 *   [ACTION] review <agentId> — <instruction>
 *
 * Rule 12.2: agent writes content, system extracts structure.
 */

import { normalizeString } from "./core/normalize.js";
import { INTENT_TYPES, normalizeSystemIntent } from "./protocol-primitives.js";

const ACTION_MARKER_RE = /\[ACTION\]\s+(.+)/i;

const ACTION_SHORTHAND_SPECS = Object.freeze({
  wake: Object.freeze({
    type: INTENT_TYPES.WAKE_AGENT,
    targetParam: "targetAgent",
    textParam: "reason",
  }),
  delegate: Object.freeze({
    type: INTENT_TYPES.ASSIGN_TASK,
    targetParam: "targetAgent",
    textParam: "instruction",
  }),
  advance: Object.freeze({
    type: INTENT_TYPES.ADVANCE_LOOP,
    targetParam: "suggestedNext",
    textParam: "reason",
  }),
  review: Object.freeze({
    type: INTENT_TYPES.REQUEST_REVIEW,
    targetParam: "targetAgent",
    textParam: "instruction",
  }),
});

function buildShorthandIntent(spec, target, text) {
  if (!spec) return null;
  return normalizeSystemIntent({
    type: spec.type,
    params: {
      ...(target ? { [spec.targetParam]: target.trim() } : {}),
      ...(text ? { [spec.textParam]: text.trim() } : {}),
    },
  });
}

function parseActionJson(payload) {
  if (!payload.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(payload);
    const normalized = normalizeSystemIntent(parsed);
    return normalized?.type ? normalized : null;
  } catch {
    return null;
  }
}

function parseActionLine(line) {
  const trimmed = normalizeString(line);
  if (!trimmed) return null;

  const jsonIntent = parseActionJson(trimmed);
  if (jsonIntent) return jsonIntent;

  // Split on first " — " (em dash) or " - " (hyphen) for reason/instruction
  const separatorMatch = trimmed.match(/^(\S+)(?:\s+(\S+))?\s*(?:—|-)\s*(.+)$/);
  if (separatorMatch) {
    const [, verb, target, reason] = separatorMatch;
    const spec = ACTION_SHORTHAND_SPECS[verb?.toLowerCase()];
    return buildShorthandIntent(spec, target, reason);
  }

  // No separator — just verb + optional target
  const simpleMatch = trimmed.match(/^(\S+)(?:\s+(.+))?$/);
  if (simpleMatch) {
    const [, verb, rest] = simpleMatch;
    const spec = ACTION_SHORTHAND_SPECS[verb?.toLowerCase()];
    return buildShorthandIntent(spec, rest, null);
  }

  return null;
}

/**
 * Extract [ACTION] markers from markdown content.
 * Returns array of normalized intent objects compatible with system_action consumption.
 */
export function extractActionMarkers(markdownContent) {
  if (typeof markdownContent !== "string") return [];

  const actions = [];
  for (const line of markdownContent.split("\n")) {
    const match = ACTION_MARKER_RE.exec(line.trim());
    if (match) {
      const parsed = parseActionLine(match[1]);
      if (parsed) actions.push(parsed);
    }
  }

  return actions;
}

/**
 * Check if markdown content contains any [ACTION] markers.
 */
export function hasActionMarkers(markdownContent) {
  if (typeof markdownContent !== "string") return false;
  return ACTION_MARKER_RE.test(markdownContent);
}
