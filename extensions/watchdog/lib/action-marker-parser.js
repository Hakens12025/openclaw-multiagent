/**
 * action-marker-parser.js — Extract [ACTION] markers from agent output markdown
 *
 * Runtime-owned system_action extraction from normal output markdown.
 * Agent writes [ACTION] markers in normal output, system extracts intent.
 *
 * Dual channel (backward-compatible — B7-structured-dispatch):
 *   1. Text channel (legacy):  [ACTION] delegate <agentId> — <instruction>
 *                              [ACTION] {"type":"assign_task","params":{...}}
 *   2. Structured channel:     a fenced ```action block whose body is a JSON
 *                              system-intent (the "function-calling" surface
 *                              for capable models). Same normalizeSystemIntent
 *                              path -> identical downstream intent, one truth.
 *
 * Provenance guard (injection hardening, OWASP LLM01):
 *   - Markers inside a Markdown blockquote (`>`) or inside any non-`action`
 *     code fence are ignored: echoed/quoted user content cannot trigger an
 *     action just by containing the marker bytes.
 *   - When the runtime supplies a per-session `sessionNonce`, every marker MUST
 *     present it (text: [ACTION:<nonce>]; structured/JSON: "provenance":"<nonce>")
 *     or it is rejected. The nonce lives only in the agent's system prompt, so
 *     content the external user echoes back cannot present it.
 *
 * Rule 12.2: agent writes content, system extracts structure.
 */

import { normalizeString } from "./core/normalize.js";
import { INTENT_TYPES, normalizeSystemIntent } from "./protocol-primitives.js";

// FIX(B7-structured-dispatch): text markers can carry a provenance nonce via an
// optional [ACTION:<nonce>] tag -> stays backward-compatible with bare [ACTION].
const ACTION_MARKER_RE = /\[ACTION(?::([A-Za-z0-9_-]+))?\]\s+(.+)/i;

// FIX(B7-structured-dispatch): whole-line fence toggle; info string "action"
// selects the structured JSON channel, every other fence is opaque code whose
// inner lines are NOT scanned for markers (injection guard).
const FENCE_LINE_RE = /^\s*```+\s*([A-Za-z0-9_-]*)\s*$/;

// FIX(B7-structured-dispatch): a blockquoted marker is quoted/echoed content,
// never the agent's own top-level directive -> ignore.
const BLOCKQUOTE_RE = /^\s*>/;

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

// FIX(B7-structured-dispatch): parse a JSON payload once, lift its provenance
// nonce out, and strip it so the consumed intent stays pure content (LLM 管内容/
// 代码管流程). Accepts "provenance":"<nonce>" or "provenance":{"nonce":"<nonce>"}.
function parseActionJsonPayload(payload) {
  const trimmed = payload.trim();
  if (!trimmed.startsWith("{")) return null;
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  const provenance = normalizeString(parsed?.provenance)
    || normalizeString(parsed?.provenance?.nonce);
  if (parsed && typeof parsed === "object" && "provenance" in parsed) {
    delete parsed.provenance;
  }
  const intent = normalizeSystemIntent(parsed);
  if (!intent?.type) return null;
  return { intent, provenance };
}

// FIX(B7-structured-dispatch): parse one text-channel payload; returns
// { intent, provenance } (provenance only from an inline JSON body, else null).
function parseActionLine(payload) {
  const trimmed = normalizeString(payload);
  if (!trimmed) return null;

  const jsonParsed = parseActionJsonPayload(trimmed);
  if (jsonParsed) return jsonParsed;

  // Split on first " — " (em dash) or " - " (hyphen) for reason/instruction
  const separatorMatch = trimmed.match(/^(\S+)(?:\s+(\S+))?\s*(?:—|-)\s*(.+)$/);
  if (separatorMatch) {
    const [, verb, target, reason] = separatorMatch;
    const spec = ACTION_SHORTHAND_SPECS[verb?.toLowerCase()];
    const intent = buildShorthandIntent(spec, target, reason);
    return intent ? { intent, provenance: null } : null;
  }

  // No separator — just verb + optional target
  const simpleMatch = trimmed.match(/^(\S+)(?:\s+(.+))?$/);
  if (simpleMatch) {
    const [, verb, rest] = simpleMatch;
    const spec = ACTION_SHORTHAND_SPECS[verb?.toLowerCase()];
    const intent = buildShorthandIntent(spec, rest, null);
    return intent ? { intent, provenance: null } : null;
  }

  return null;
}

// FIX(B7-structured-dispatch): single document-order pass. A fence state-machine
// routes ```action bodies to the structured channel and drops every other fenced
// or blockquoted line so quoted/echoed content can't be scanned for markers.
function scanMarkerCandidates(markdownContent, rejectQuoted) {
  const candidates = [];
  let fenceLang = null; // null = outside any fence
  let fenceBuf = [];
  for (const rawLine of markdownContent.split("\n")) {
    const fenceMatch = rawLine.match(FENCE_LINE_RE);
    if (fenceMatch) {
      if (fenceLang === null) {
        fenceLang = (fenceMatch[1] || "").toLowerCase();
        fenceBuf = [];
      } else {
        if (fenceLang === "action") {
          candidates.push({ kind: "structured", payload: fenceBuf.join("\n"), tagNonce: null });
        }
        fenceLang = null;
        fenceBuf = [];
      }
      continue;
    }
    if (fenceLang !== null) {
      fenceBuf.push(rawLine); // inside a fence: only ```action bodies are emitted
      continue;
    }
    if (rejectQuoted && BLOCKQUOTE_RE.test(rawLine)) continue;
    const match = ACTION_MARKER_RE.exec(rawLine.trim());
    if (!match) continue;
    candidates.push({ kind: "text", payload: match[2], tagNonce: normalizeString(match[1]) });
  }
  return candidates;
}

// FIX(B7-structured-dispatch): capability-token check. No sessionNonce =>
// enforcement off (legacy/default). Otherwise the marker must present the nonce
// via its tag or its JSON provenance.
function presentsNonce(tagNonce, jsonProvenance, sessionNonce) {
  if (!sessionNonce) return true;
  const presented = normalizeString(tagNonce) || normalizeString(jsonProvenance);
  return presented === sessionNonce;
}

/**
 * Extract [ACTION] markers from markdown content.
 * Returns array of normalized intent objects compatible with system_action consumption.
 *
 * @param {string} markdownContent
 * @param {{ sessionNonce?: string|null, rejectQuoted?: boolean }} [options]
 *   sessionNonce  per-session provenance nonce. When set, (a) the structured
 *                 ```action channel activates and (b) every marker must present the
 *                 nonce or is rejected. Omit/null = today's permissive text-only
 *                 behavior, and the structured channel stays inert.
 *   rejectQuoted  default true; skip markers inside Markdown blockquotes (`>`).
 *                 Non-`action` code fences are ALWAYS opaque (a security invariant,
 *                 independent of this flag).
 */
// FIX(B7-structured-dispatch): options add the structured channel + provenance
// guard without changing the single-arg contract existing callers rely on.
export function extractActionMarkers(markdownContent, options = {}) {
  if (typeof markdownContent !== "string") return [];
  const sessionNonce = normalizeString(options.sessionNonce);
  const rejectQuoted = options.rejectQuoted !== false;

  const actions = [];
  for (const candidate of scanMarkerCandidates(markdownContent, rejectQuoted)) {
    // FIX(B7-structured-dispatch/review): the structured ```action channel is the
    // function-calling surface and activates ONLY once the runtime has provisioned a
    // session nonce (its provenance guard). Until then it stays inert — matching main
    // and closing the vector where an echoed ```action fence in user content would
    // otherwise become a privileged action while the nonce is unwired.
    if (candidate.kind === "structured" && !sessionNonce) continue;
    const parsed = candidate.kind === "structured"
      ? parseActionJsonPayload(candidate.payload)
      : parseActionLine(candidate.payload);
    if (!parsed?.intent) continue;
    if (!presentsNonce(candidate.tagNonce, parsed.provenance, sessionNonce)) continue;
    actions.push(parsed.intent);
  }

  return actions;
}
