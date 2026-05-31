import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { generateReport } from "./formal-runtime/suite-single.js";
import { generateLoopPlatformReport } from "./formal-runtime/suite-loop-platform.js";

export function buildTestRunReportText({ run, preset } = {}) {
  if (!run || typeof run !== "object") {
    throw new TypeError("buildTestRunReportText requires run");
  }
  if (!preset || typeof preset !== "object") {
    throw new TypeError("buildTestRunReportText requires preset");
  }
  const durationSec = ((run.finishedAt - run.startedAt) / 1000).toFixed(1);
  if (preset.suite === "loop-platform") {
    return generateLoopPlatformReport(run.caseResults, durationSec);
  }
  return generateReport(run.caseResults, `devtool:${preset.id}`, durationSec);
}

export async function writeTestRunArtifacts({
  run,
  preset,
  reportsDir,
  nowTs,
  snapshotRun,
} = {}) {
  if (!reportsDir) {
    throw new TypeError("writeTestRunArtifacts requires reportsDir");
  }
  if (typeof nowTs !== "function") {
    throw new TypeError("writeTestRunArtifacts requires nowTs");
  }
  if (typeof snapshotRun !== "function") {
    throw new TypeError("writeTestRunArtifacts requires snapshotRun");
  }

  await mkdir(reportsDir, { recursive: true });
  const prefix = `devtool-${preset.id}`;
  const reportText = buildTestRunReportText({ run, preset });
  const ts = nowTs();
  const reportFile = run.reportFile || join(reportsDir, `${prefix}-${ts}.txt`);
  const rawReportFile = run.rawReportFile || join(reportsDir, `${prefix}-${ts}.json`);

  run.reportFile = reportFile;
  run.rawReportFile = rawReportFile;
  run.reportText = reportText;

  await writeFile(reportFile, reportText, "utf8");
  await writeFile(rawReportFile, JSON.stringify(snapshotRun(run, true), null, 2), "utf8");

  return {
    reportFile,
    rawReportFile,
  };
}
