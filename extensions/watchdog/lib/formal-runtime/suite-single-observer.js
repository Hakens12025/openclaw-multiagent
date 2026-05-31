// SSE drain, contract poll, output validation, and result-building helpers for suite-single

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  OUTPUT_DIR,
  fetchJSON,
  sleep,
  postAdmin,
} from "./infra.js";
import { readContractSnapshotById } from "../contracts.js";
import { resolveRuntimeResultOutputPath } from "../routing/delivery-result.js";
import { evaluateOutputValidation } from "../test-output-validation.js";
import { CONTRACT_STATUS } from "../core/runtime-status.js";

// ── Helper: drain SSE events into timeline ─────────────────────────────────

function isFormalTimelineVisibleEvent(evt) {
  return evt?.data?.formalTimelineVisible !== false;
}

export function drainSSEEvents(sse, startMs, contractId, timeline) {
  let lastObservedAt = 0;
  for (const evt of sse.events) {
    if (evt.claimed || evt.replay || evt.receivedAt < startMs) continue;
    const evtCid = evt.data?.contractId;
    const matchesCid = !contractId || !evtCid || evtCid === contractId;
    if (!matchesCid) continue;

    if (evt.type === "track_start") {
      if (!isFormalTimelineVisibleEvent(evt)) { evt.claimed = true; continue; }
      evt.claimed = true;
      lastObservedAt = Math.max(lastObservedAt, evt.receivedAt);
      timeline.push({ at: evt.receivedAt, event: "agent session start", agentId: evt.data?.agentId });
    } else if (evt.type === "track_end") {
      if (!isFormalTimelineVisibleEvent(evt)) { evt.claimed = true; continue; }
      evt.claimed = true;
      lastObservedAt = Math.max(lastObservedAt, evt.receivedAt);
      timeline.push({ at: evt.receivedAt, event: "agent session end", agentId: evt.data?.agentId, status: evt.data?.status });
    } else if (evt.type === "track_progress") {
      if (!isFormalTimelineVisibleEvent(evt)) { evt.claimed = true; continue; }
      evt.claimed = true;
      lastObservedAt = Math.max(lastObservedAt, evt.receivedAt);
      timeline.push({ at: evt.receivedAt, event: "agent tool call", agentId: evt.data?.agentId, toolCallCount: evt.data?.toolCallCount });
    } else if (evt.type === "alert" && evt.data?.type === "delivery_created") {
      evt.claimed = true;
      lastObservedAt = Math.max(lastObservedAt, evt.receivedAt);
      timeline.push({ at: evt.receivedAt, event: "delivery created", contractId: evt.data?.contractId });
    } else if (evt.type === "alert" && evt.data?.type === "delivery_notified") {
      evt.claimed = true;
      lastObservedAt = Math.max(lastObservedAt, evt.receivedAt);
      timeline.push({ at: evt.receivedAt, event: "delivery notified", contractId: evt.data?.contractId, agentId: evt.data?.agentId });
    }
  }
  return lastObservedAt;
}

// ── Helper: poll contracts API to find contract by task text ───────────────

export async function pollForContract(taskText, afterMs, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const contracts = await fetchJSON("/watchdog/work-items");
      const match = contracts.find((c) => {
        const createdAt = Number(c?.createdAt || 0);
        const task = String(c?.task || "");
        return task.includes(taskText.slice(0, 50)) && createdAt >= (afterMs - 2000);
      });
      if (match) return match;
    } catch {}
    await sleep(1000);
  }
  return null;
}

// ── Helper: validate output file ──────────────────────────────────────────

export async function resolveValidationOutputPath(contractId) {
  try {
    const contractSnapshot = await readContractSnapshotById(contractId);
    const runtimeOutputPath = resolveRuntimeResultOutputPath(contractSnapshot);
    if (runtimeOutputPath) {
      return runtimeOutputPath;
    }
  } catch {}

  let outputPath = null;
  try {
    const files = await readdir(OUTPUT_DIR);
    const match = files.find((f) => f.includes(contractId));
    if (match) outputPath = join(OUTPUT_DIR, match);
  } catch {}

  return outputPath;
}

export async function validateOutput(contractId, validate) {
  if (!validate) return { ok: true };
  const outputPath = await resolveValidationOutputPath(contractId);

  if (!outputPath) {
    return { ok: false, errorCode: "E_OUTPUT_MISSING", detail: `no output file found for ${contractId}` };
  }

  let content = "";
  let size = 0;
  try {
    const buf = await readFile(outputPath);
    size = buf.length;
    content = buf.toString("utf8");
  } catch (e) {
    return { ok: false, errorCode: "E_OUTPUT_MISSING", detail: `read failed: ${e.message}` };
  }

  const minBytes = validate.minBytes || 0;
  const validation = evaluateOutputValidation({
    content,
    validate,
    sizeFailureCode: "E_OUTPUT_TOO_SMALL",
    keywordFailureCode: "E_OUTPUT_KEYWORD_MISS",
  });
  if (!validation.ok) {
    if (validation.status === "E_OUTPUT_TOO_SMALL") {
      return { ok: false, errorCode: "E_OUTPUT_TOO_SMALL", detail: `expected >= ${minBytes} bytes, got ${size}` };
    }
    return {
      ok: false,
      errorCode: "E_OUTPUT_KEYWORD_MISS",
      detail: `missing keywords: ${validation.missingKeywords.join(", ")}`,
    };
  }

  return { ok: true, size, path: outputPath };
}

// ── Helper: terminate a timed-out contract ────────────────────────────────

export async function markTimedOutContract(contractId, detail) {
  if (!contractId) return null;
  const response = await postAdmin("/watchdog/tests/terminalize", {
    contractId,
    status: CONTRACT_STATUS.FAILED,
    source: "test_runner",
    reason: "case_timeout",
    summary: detail,
    retryable: false,
  });
  if (response?.ok === false) {
    throw new Error(response.error || "test terminalize failed");
  }
  return await readContractSnapshotById(contractId);
}

// ── Helper: pick contract runtime snapshot fields ─────────────────────────

export function pickSingleContractRuntimeSnapshot(contract) {
  if (!contract || typeof contract !== "object") return null;
  return {
    status: contract.status || null,
    taskType: contract.taskType || null,
    protocol: contract.protocol || null,
    coordination: contract.coordination || null,
    followUp: contract.followUp || null,
    systemActionDelivery: contract.systemActionDelivery || null,
    terminalOutcome: contract.terminalOutcome || null,
    systemAction: contract.systemAction || null,
    runtimeDiagnostics: contract.runtimeDiagnostics || null,
  };
}

// ── Helper: assemble result object ────────────────────────────────────────

export function buildResult(testCase, {
  verdict,
  errorCode,
  detail,
  timeline,
  elapsed,
  contractId,
  outputInfo,
  contractRuntime = null,
  incident = null,
  randomRuntime = null,
}) {
  return {
    testCase,
    results: timeline,
    duration: elapsed,
    pass: verdict === "PASS",
    blocked: verdict === "BLOCKED",
    contractId: contractId || null,
    outputInfo: outputInfo || null,
    errorCode: verdict !== "PASS" ? (errorCode || "UNKNOWN") : null,
    errorDetail: verdict !== "PASS" ? detail : null,
    contractRuntime,
    incident,
    randomRuntime,
  };
}
