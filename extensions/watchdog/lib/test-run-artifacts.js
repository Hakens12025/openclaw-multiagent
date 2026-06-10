// lib/test-run-artifacts.js — 报告落盘（文件命名/目录不变：devtool-<presetId>-<ts>.txt/.json）
// .txt = generateFormalReport（failures-first 布局）；.json = buildFormalReportJson（机器可读镜像）。

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { buildFormalReportJson, generateFormalReport } from "./formal-runtime/formal-report.js";
import { PORT } from "./formal-runtime/infra-tokens.js";

function buildReportRunMeta({ run, preset }) {
  return {
    presetId: preset.id,
    label: run.label || preset.label || null,
    startedAt: run.startedAt || null,
    finishedAt: run.finishedAt || null,
    gatewayPort: PORT,
  };
}

export function buildTestRunReportText({ run, preset } = {}) {
  if (!run || typeof run !== "object") {
    throw new TypeError("buildTestRunReportText requires run");
  }
  if (!preset || typeof preset !== "object") {
    throw new TypeError("buildTestRunReportText requires preset");
  }
  return generateFormalReport({
    run: buildReportRunMeta({ run, preset }),
    checks: run.checks || [],
  });
}

export async function writeTestRunArtifacts({
  run,
  preset,
  reportsDir,
  nowTs,
} = {}) {
  if (!reportsDir) {
    throw new TypeError("writeTestRunArtifacts requires reportsDir");
  }
  if (typeof nowTs !== "function") {
    throw new TypeError("writeTestRunArtifacts requires nowTs");
  }

  await mkdir(reportsDir, { recursive: true });
  const prefix = `devtool-${preset.id}`;
  const reportText = buildTestRunReportText({ run, preset });
  const reportJson = buildFormalReportJson({
    run: buildReportRunMeta({ run, preset }),
    checks: run.checks || [],
  });
  const ts = nowTs();
  const reportFile = run.reportFile || join(reportsDir, `${prefix}-${ts}.txt`);
  const rawReportFile = run.rawReportFile || join(reportsDir, `${prefix}-${ts}.json`);

  run.reportFile = reportFile;
  run.rawReportFile = rawReportFile;
  run.reportText = reportText;

  await writeFile(reportFile, reportText, "utf8");
  await writeFile(rawReportFile, JSON.stringify(reportJson, null, 2), "utf8");

  return {
    reportFile,
    rawReportFile,
  };
}
