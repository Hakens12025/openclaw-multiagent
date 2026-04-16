// lib/execution-trace-store.js — Execution trace with commitment detection
//
// Records a hash chain of tool calls per session. Compares writes against
// expectations derived from the contract so agent_end can judge success
// without reading the filesystem.

import { createHash } from "node:crypto";
import { clearSession as clearLoopSession, clearAllSessions as clearAllLoopSessions } from "../loop/loop-detection.js";

const traces = new Map();

function sha256(data) {
  return createHash("sha256").update(data).digest("hex");
}

function normalizeSessionKey(sessionKey) {
  return typeof sessionKey === "string" && sessionKey.trim() ? sessionKey.trim() : null;
}

/**
 * Initialize trace for a session. Extracts expectations from contract.
 */
export function initTrace(sessionKey, contract) {
  const key = normalizeSessionKey(sessionKey);
  if (!key) return null;

  const expectations = [];

  // Rule 1: contract.output → expect write to that path
  if (contract?.output) {
    expectations.push({ type: "write", path: contract.output, label: "output" });
  }

  // Rule 2: system_action now uses [ACTION] markers in output text (Rule 12.2).
  // Historical file-based system_action monitoring has been removed.

  const trace = {
    sessionKey: key,
    contractId: contract?.id || null,
    expectations,
    steps: [],
    lastHash: null,
    commitments: {
      outputWritten: false,
      systemActionSeen: false,
    },
    startedAt: Date.now(),
  };

  traces.set(key, trace);
  return trace;
}

/**
 * Record a tool call step into the hash chain.
 * Returns matched expectation labels (e.g. ["output"]) or null.
 */
export function recordStep(sessionKey, { tool, targetPath }) {
  const key = normalizeSessionKey(sessionKey);
  if (!key) return null;

  const trace = traces.get(key);
  if (!trace) return null;

  const step = {
    tool: tool || "unknown",
    targetPath: targetPath || "",
    timestamp: Date.now(),
    prevHash: trace.lastHash,
  };
  step.hash = sha256(JSON.stringify(step));
  trace.steps.push(step);
  trace.lastHash = step.hash;

  // Check commitments on write operations
  const isWrite = /^(write|Write|create|Create|edit|Edit|apply_patch)$/i.test(tool);
  if (!isWrite || !targetPath) return null;

  const matches = [];
  for (const exp of trace.expectations) {
    if (exp.path && targetPath.includes(exp.path)) {
      if (exp.label === "output") trace.commitments.outputWritten = true;
      matches.push(exp.label);
    }
    if (exp.pathPattern && targetPath.includes(exp.pathPattern)) {
      if (exp.label === "system_action") trace.commitments.systemActionSeen = true;
      matches.push(exp.label);
    }
  }

  return matches.length > 0 ? matches : null;
}

/**
 * Get current trace for a session.
 */
function getTrace(sessionKey) {
  const key = normalizeSessionKey(sessionKey);
  return key ? traces.get(key) || null : null;
}

/**
 * Record a delegation intent when runtime classifies a system_action commit.
 * Called from after_tool_call with pre-parsed action data.
 */
export function recordDelegationIntent(sessionKey, { intentType, targetAgent, valid, error }) {
  const key = normalizeSessionKey(sessionKey);
  if (!key) return null;

  const trace = traces.get(key);
  if (!trace) return null;

  const receipt = {
    delegationId: `DEL-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    parentSession: key,
    intentType: intentType || null,
    targetAgent: targetAgent || null,
    valid: valid === true,
    error: error || null,
    parentTraceHash: trace.lastHash,
    issuedAt: Date.now(),
  };

  trace.delegationReceipt = receipt;
  return receipt;
}

/**
 * Evaluate trace and return a verdict object.
 */
export function evaluateTrace(sessionKey) {
  const key = normalizeSessionKey(sessionKey);
  if (!key) return null;

  const trace = traces.get(key);
  if (!trace) return null;

  const totalCalls = trace.steps.length;
  const hasOutputExpectation = trace.expectations.some(e => e.label === "output");

  // off-track: expected output but never wrote it after 15+ tool calls
  const offTrack = hasOutputExpectation && !trace.commitments.outputWritten && totalCalls >= 15;

  return {
    contractId: trace.contractId,
    totalCalls,
    outputCommitted: trace.commitments.outputWritten,
    systemActionSeen: trace.commitments.systemActionSeen,
    offTrack,
    traceHash: trace.lastHash,
    elapsedMs: Date.now() - trace.startedAt,
    delegationReceipt: trace.delegationReceipt || null,
  };
}

/**
 * Clear trace for a session.
 */
export function clearTrace(sessionKey) {
  const key = normalizeSessionKey(sessionKey);
  if (!key) return false;
  clearLoopSession(key);
  return traces.delete(key);
}

/**
 * Clear all traces. Returns count cleared.
 */
export function clearAllTraces() {
  const count = traces.size;
  traces.clear();
  clearAllLoopSessions();
  return count;
}
