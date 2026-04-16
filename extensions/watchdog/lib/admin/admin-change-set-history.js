import { randomBytes } from "node:crypto";

import { normalizeManagementContext } from "./admin-change-set-management.js";
import { normalizeRecord, normalizeString } from "../core/normalize.js";

function normalizeArray(value) {
  return Array.isArray(value) ? value : [];
}

export function makeVerificationId() {
  return `ACV-${Date.now()}-${randomBytes(3).toString("hex")}`;
}

export function makeExecutionId() {
  return `ACE-${Date.now()}-${randomBytes(3).toString("hex")}`;
}

export function normalizeVerificationStatus(record) {
  if (!record) return null;
  if (record.failedCases > 0 || record.status === "failed") return "failed";
  if (record.blockedCases > 0) return "blocked";
  if (record.status === "completed" && (record.totalCases || 0) > 0) return "passed";
  if (["queued", "preparing", "running", "cleaning"].includes(record.status)) return "running";
  return record.status || "unknown";
}

export function normalizeVerificationHistory(value) {
  return normalizeArray(value)
    .map((entry) => {
      const record = normalizeRecord(entry);
      return {
        id: normalizeString(record.id) || makeVerificationId(),
        source: normalizeString(record.source) || "unknown",
        runId: normalizeString(record.runId),
        reportPath: normalizeString(record.reportPath),
        reportFile: normalizeString(record.reportFile),
        rawReportFile: normalizeString(record.rawReportFile),
        note: normalizeString(record.note),
        linkedAt: Number.isFinite(record.linkedAt) ? record.linkedAt : null,
        presetId: normalizeString(record.presetId),
        label: normalizeString(record.label),
        suite: normalizeString(record.suite),
        status: normalizeString(record.status),
        verificationStatus: normalizeString(record.verificationStatus) || normalizeVerificationStatus(record),
        startedAt: Number.isFinite(record.startedAt) ? record.startedAt : null,
        finishedAt: Number.isFinite(record.finishedAt) ? record.finishedAt : null,
        durationMs: Number.isFinite(record.durationMs) ? record.durationMs : null,
        totalCases: Number.isFinite(record.totalCases) ? record.totalCases : 0,
        completedCases: Number.isFinite(record.completedCases) ? record.completedCases : 0,
        passedCases: Number.isFinite(record.passedCases) ? record.passedCases : 0,
        failedCases: Number.isFinite(record.failedCases) ? record.failedCases : 0,
        blockedCases: Number.isFinite(record.blockedCases) ? record.blockedCases : 0,
        failedCaseIds: normalizeArray(record.failedCaseIds).filter((item) => typeof item === "string"),
        blockedCaseIds: normalizeArray(record.blockedCaseIds).filter((item) => typeof item === "string"),
      };
    })
    .sort((a, b) => (b.linkedAt || 0) - (a.linkedAt || 0));
}

export function summarizeVerificationHistory(history) {
  const normalized = normalizeVerificationHistory(history);
  const latest = normalized[0] || null;
  return {
    verificationHistory: normalized,
    verificationCount: normalized.length,
    lastVerificationAt: latest?.linkedAt || null,
    lastVerificationStatus: latest?.verificationStatus || null,
    lastVerificationRunId: latest?.runId || null,
  };
}

export function normalizeExecutionStatus(record) {
  if (!record) return null;
  if (record.executionStatus) return normalizeString(record.executionStatus);
  if (record.status === "failed") return "failed";
  if (record.dryRun) return "previewed";
  if (record.status === "completed") return "applied";
  return normalizeString(record.status) || "unknown";
}

export function normalizeExecutionHistory(value) {
  return normalizeArray(value)
    .map((entry) => {
      const record = normalizeRecord(entry);
      return {
        id: normalizeString(record.id) || makeExecutionId(),
        surfaceId: normalizeString(record.surfaceId),
        dryRun: record.dryRun === true,
        status: normalizeString(record.status) || "completed",
        executionStatus: normalizeExecutionStatus(record),
        note: normalizeString(record.note),
        startedAt: Number.isFinite(record.startedAt) ? record.startedAt : null,
        finishedAt: Number.isFinite(record.finishedAt) ? record.finishedAt : null,
        durationMs: Number.isFinite(record.durationMs) ? record.durationMs : null,
        payload: normalizeRecord(record.payload),
        result: normalizeRecord(record.result),
        error: normalizeString(record.error),
        managementContext: normalizeManagementContext(record.managementContext),
      };
    })
    .sort((a, b) => (b.finishedAt || b.startedAt || 0) - (a.finishedAt || a.startedAt || 0));
}

export function summarizeExecutionHistory(history) {
  const normalized = normalizeExecutionHistory(history);
  const latest = normalized[0] || null;
  return {
    executionHistory: normalized,
    executionCount: normalized.length,
    lastExecutionAt: latest?.finishedAt || latest?.startedAt || null,
    lastExecutionStatus: latest?.executionStatus || null,
  };
}

export function resolveDraftStatus({
  storedStatus = null,
  lastExecutionStatus = null,
  lastVerificationStatus = null,
}) {
  const normalizedStoredStatus = normalizeString(storedStatus) || "draft";
  switch (normalizeString(lastVerificationStatus)) {
    case "passed":
      return "verified";
    case "failed":
      return "verification_failed";
    case "blocked":
      return "verification_blocked";
    case "running":
      return "verifying";
    default:
      break;
  }

  switch (normalizeString(lastExecutionStatus)) {
    case "applied":
      return "applied";
    case "failed":
      return "failed";
    case "previewed":
      return "previewed";
    default:
      return normalizedStoredStatus;
  }
}

export function mergeVerificationRecord(history, record) {
  const normalizedHistory = normalizeVerificationHistory(history);
  const existingIndex = normalizedHistory.findIndex((entry) => (
    (record.runId && entry.runId === record.runId)
    || (record.reportPath && entry.reportPath === record.reportPath)
  ));
  if (existingIndex >= 0) {
    normalizedHistory[existingIndex] = {
      ...normalizedHistory[existingIndex],
      ...record,
      id: normalizedHistory[existingIndex].id,
    };
  } else {
    normalizedHistory.unshift(record);
  }
  return normalizeVerificationHistory(normalizedHistory);
}

export function appendExecutionRecord(history, record) {
  return normalizeExecutionHistory([record, ...normalizeExecutionHistory(history)]);
}
