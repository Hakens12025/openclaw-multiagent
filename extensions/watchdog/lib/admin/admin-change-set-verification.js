import { readFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import {
  makeVerificationId,
  normalizeVerificationStatus,
} from "./admin-change-set-history.js";
import { normalizeRecord, normalizeString } from "../core/normalize.js";
import { OC } from "../state.js";
import { getTestRunDetails } from "../test-runs.js";

const TEST_REPORTS_DIR = join(OC, "test-reports");

function normalizeArray(value) {
  return Array.isArray(value) ? value : [];
}

function computeDurationMs(run) {
  if (Number.isFinite(run.durationMs)) return run.durationMs;
  if (Number.isFinite(run.startedAt) && Number.isFinite(run.finishedAt) && run.finishedAt >= run.startedAt) {
    return run.finishedAt - run.startedAt;
  }
  return null;
}

export function summarizeVerificationRun(run, { source, reportPath = null, note = null }) {
  const caseResults = normalizeArray(run.caseResults).map(normalizeRecord);
  const failedCaseIds = caseResults
    .filter((item) => item.pass !== true && item.blocked !== true)
    .map((item) => normalizeString(item.id))
    .filter(Boolean);
  const blockedCaseIds = caseResults
    .filter((item) => item.blocked === true)
    .map((item) => normalizeString(item.id))
    .filter(Boolean);
  const record = {
    id: makeVerificationId(),
    source,
    runId: normalizeString(run.id),
    reportPath,
    reportFile: normalizeString(run.reportFile),
    rawReportFile: normalizeString(run.rawReportFile),
    note,
    linkedAt: Date.now(),
    presetId: normalizeString(run.presetId),
    label: normalizeString(run.label),
    suite: normalizeString(run.suite),
    status: normalizeString(run.status),
    startedAt: Number.isFinite(run.startedAt) ? run.startedAt : null,
    finishedAt: Number.isFinite(run.finishedAt) ? run.finishedAt : null,
    durationMs: computeDurationMs(run),
    totalCases: Number.isFinite(run.totalCases) ? run.totalCases : caseResults.length,
    completedCases: Number.isFinite(run.completedCases) ? run.completedCases : caseResults.length,
    passedCases: Number.isFinite(run.passedCases) ? run.passedCases : caseResults.filter((item) => item.pass === true).length,
    failedCases: Number.isFinite(run.failedCases) ? run.failedCases : failedCaseIds.length,
    blockedCases: Number.isFinite(run.blockedCases) ? run.blockedCases : blockedCaseIds.length,
    failedCaseIds,
    blockedCaseIds,
  };
  return {
    ...record,
    verificationStatus: normalizeVerificationStatus(record),
  };
}

function resolveAllowedReportPath(value) {
  const normalized = normalizeString(value);
  if (!normalized) return null;
  const candidate = isAbsolute(normalized) ? resolve(normalized) : resolve(OC, normalized);
  const rel = relative(TEST_REPORTS_DIR, candidate);
  if (!candidate.endsWith(".json")) {
    throw new Error("reportPath must point to a json report");
  }
  if (rel === "" || rel === ".") {
    throw new Error("reportPath must point to a file under test-reports");
  }
  if (rel.startsWith(`..${sep}`) || rel === ".." || isAbsolute(rel)) {
    throw new Error("reportPath must stay inside test-reports");
  }
  return candidate;
}

export async function resolveVerificationRun(payload) {
  const runId = normalizeString(payload.runId);
  if (runId) {
    const run = getTestRunDetails(runId);
    if (!run) {
      throw new Error(`test run not found: ${runId}`);
    }
    return {
      source: "test_run",
      reportPath: normalizeString(run.rawReportFile),
      run,
    };
  }

  const reportPath = resolveAllowedReportPath(payload.reportPath);
  if (!reportPath) {
    throw new Error("missing runId or reportPath");
  }
  const run = JSON.parse(await readFile(reportPath, "utf8"));
  return {
    source: "report_file",
    reportPath,
    run,
  };
}
