import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { normalizeString } from "../core/normalize.js";

const TEST_REPORTS_DIR = join(homedir(), ".openclaw", "test-reports");
const DEFAULT_TEST_REPORT_LIMIT = 5;

function compactText(value, maxLength = 120) {
  const normalized = normalizeString(value);
  if (!normalized) return null;
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 3))}...`;
}

function summarizeTestReport(content, filename) {
  const lines = String(content || "").split("\n");
  const passCount = (content.match(/\[PASS\]/g) || []).length;
  const failCount = (content.match(/\[FAIL\]/g) || []).length;

  const summaryMatch = content.match(/SUMMARY:\s*(\d+)\/(\d+)\s+PASSED\s+(\d+)\s+FAILED(?:\s+(\d+)\s+BLOCKED)?/);
  const passed = summaryMatch ? Number.parseInt(summaryMatch[1], 10) : passCount;
  const total = summaryMatch ? Number.parseInt(summaryMatch[2], 10) : passCount + failCount;
  const failed = summaryMatch ? Number.parseInt(summaryMatch[3], 10) : failCount;
  const blocked = summaryMatch && summaryMatch[4] ? Number.parseInt(summaryMatch[4], 10) : 0;

  const suiteMatch = content.match(/Suite:\s*(\S+)/);
  const suite = suiteMatch ? suiteMatch[1] : null;

  const durationMatch = content.match(/Duration:\s*([\d.]+)s/);
  const duration = durationMatch ? `${durationMatch[1]}s` : null;

  const failedCases = [];
  const failureSection = content.split("FAILURES:")[1];
  if (failureSection) {
    const casePattern = /^\s+(\S+):\s+(\S+)\s+\[([^\]]*)\]/gm;
    let match;
    while ((match = casePattern.exec(failureSection)) !== null && failedCases.length < 5) {
      failedCases.push({
        caseId: match[1],
        errorCode: match[2],
        phase: match[3],
      });
    }
  }

  return {
    filename,
    suite,
    duration,
    passed,
    failed,
    blocked,
    total,
    verdict: failed > 0 ? "FAIL" : "PASS",
    failedCases,
  };
}

export async function loadRecentTestReports(limit = DEFAULT_TEST_REPORT_LIMIT) {
  let entries;
  try {
    entries = await readdir(TEST_REPORTS_DIR);
  } catch {
    return [];
  }

  const txtFiles = entries.filter((name) => name.endsWith(".txt"));

  const withStats = await Promise.all(
    txtFiles.map(async (name) => {
      try {
        const filePath = join(TEST_REPORTS_DIR, name);
        const fileStat = await stat(filePath);
        return { name, mtimeMs: fileStat.mtimeMs, filePath };
      } catch {
        return null;
      }
    }),
  );

  const sorted = withStats
    .filter(Boolean)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, limit);

  const reports = await Promise.all(
    sorted.map(async (entry) => {
      try {
        const content = await readFile(entry.filePath, "utf-8");
        const report = summarizeTestReport(content, entry.name);
        report.modifiedAt = Math.round(entry.mtimeMs);
        return report;
      } catch {
        return null;
      }
    }),
  );

  return reports.filter(Boolean);
}

export function summarizeTestRun(run) {
  return {
    id: run?.id || "unknown",
    presetId: run?.presetId || null,
    label: run?.label || null,
    suite: run?.suite || null,
    status: run?.status || null,
    startedAt: Number.isFinite(run?.startedAt) ? run.startedAt : null,
    finishedAt: Number.isFinite(run?.finishedAt) ? run.finishedAt : null,
    totalCases: Number.isFinite(run?.totalCases) ? run.totalCases : 0,
    completedCases: Number.isFinite(run?.completedCases) ? run.completedCases : 0,
    passedCases: Number.isFinite(run?.passedCases) ? run.passedCases : 0,
    failedCases: Number.isFinite(run?.failedCases) ? run.failedCases : 0,
    blockedCases: Number.isFinite(run?.blockedCases) ? run.blockedCases : 0,
    currentCaseId: run?.currentCaseId || null,
    currentCaseMessage: run?.currentCaseMessage || null,
    originDraftId: run?.originDraftId || null,
    originExecutionId: run?.originExecutionId || null,
    originSurfaceId: run?.originSurfaceId || null,
  };
}

export function summarizeHarnessRun(run) {
  return {
    runId: run?.id || run?.runId || "unknown",
    status: run?.status || null,
    startedAt: Number.isFinite(run?.startedAt) ? run.startedAt : null,
    endedAt: Number.isFinite(run?.finalizedAt) ? run.finalizedAt : (Number.isFinite(run?.endedAt) ? run.endedAt : null),
    agentId: run?.executor?.agentId || null,
    contractId: run?.contractId || null,
    totalCalls: run?.toolUsage?.totalCalls || 0,
    result: run?.terminalStatus || run?.status || run?.outcome?.result || null,
    summary: compactText(run?.summary || run?.outcome?.summary, 120),
  };
}
