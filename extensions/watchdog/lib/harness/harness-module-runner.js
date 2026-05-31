import { buildReviewerResult } from "./reviewer-result.js";
import {
  normalizeHarnessRun,
} from "./harness-run.js";
import { validateCoverageCompleteness } from "./run-shape-map.js";
import { normalizeString } from "../core/normalize.js";

import {
  normalizeFiniteNumber,
  listModuleIds,
  resolveExecutionContext,
} from "./harness-module-evidence.js";

import {
  buildStartModuleRun,
  buildFinalModuleRun,
} from "./harness-module-evaluators.js";

const FAILURE_CLASS_MODULE_ID = "harness:normalizer.failure";

export async function initializeHarnessRunModules(harnessRun, {
  automationSpec = null,
} = {}) {
  const run = normalizeHarnessRun(harnessRun);
  if (!run) return null;
  const executionContext = await resolveExecutionContext(automationSpec);

  // coverage 完整性校验（备忘录78 §7.1 消除假安全感）：装了硬管模块却没在
  // RunShapeMap.hardShaped 标注的段 → 记进 diagnostics.warnings（非硬失败，避免破坏跑通）。
  const completeness = validateCoverageCompleteness(run.runShapeMap, listModuleIds(run));
  const diagnostics = completeness.warnings.length > 0
    ? {
        ...(run.diagnostics || {}),
        warnings: [
          ...((run.diagnostics?.warnings) || []),
          ...completeness.warnings,
        ],
      }
    : run.diagnostics;

  return normalizeHarnessRun({
    ...run,
    diagnostics,
    moduleRuns: listModuleIds(run).map((moduleId) => buildStartModuleRun(
      moduleId,
      run,
      automationSpec,
      executionContext,
    )),
  });
}

function deriveReviewerResultFromModules(finalizedRun, { score, artifact, terminalStatus, summary } = {}) {
  const run = normalizeHarnessRun(finalizedRun);
  if (!run) return null;

  const gateSummary = run.gateSummary;
  const gateVerdict = gateSummary?.verdict || "none";
  const moduleRuns = Array.isArray(run.moduleRuns) ? run.moduleRuns : [];

  let verdict = "inconclusive";
  if (gateVerdict === "passed") verdict = "pass";
  else if (gateVerdict === "failed") verdict = "fail";
  else if (gateVerdict === "pending") verdict = "inconclusive";

  const findings = moduleRuns
    .filter((m) => m?.status === "failed" && m?.summary)
    .map((m) => ({
      category: m.kind || "module",
      severity: m.kind === "gate" ? "error" : "warning",
      message: m.summary,
      evidence: m.reason || null,
    }));

  const failureClassModule = moduleRuns.find((m) => m?.moduleId === FAILURE_CLASS_MODULE_ID && m?.evidence?.failureClass);
  const failureClass = failureClassModule?.evidence?.failureClass || null;

  let continueHint = null;
  if (verdict === "fail") continueHint = "rework";
  else if (verdict === "pass") continueHint = "continue";

  return buildReviewerResult({
    source: "harness_module",
    score: normalizeFiniteNumber(score, run.score),
    verdict,
    findings,
    failureClass,
    artifactRef: normalizeString(artifact) || run.artifact || null,
    reworkTarget: null,
    continueHint,
    round: run.round || null,
    contractId: run.contractId || null,
    pipelineId: run.pipelineId || null,
    loopId: run.loopId || null,
    ts: run.finalizedAt || Date.now(),
  });
}

export async function finalizeHarnessRunModules(harnessRun, {
  automationSpec = null,
  terminalSource = null,
  terminalStatus = null,
  score = null,
  artifact = null,
  summary = null,
  finalizedAt = Date.now(),
} = {}) {
  const run = normalizeHarnessRun(harnessRun);
  if (!run) return null;
  const executionContext = await resolveExecutionContext(automationSpec);

  const builtModuleRuns = listModuleIds(run).map((moduleId) => buildFinalModuleRun(
    moduleId,
    run,
    automationSpec,
    terminalSource,
    {
      terminalStatus,
      score,
      artifact,
      summary,
      finalizedAt,
    },
    executionContext,
  ));

  let finalizedRun = normalizeHarnessRun({
    ...run,
    finalizedAt,
    terminalStatus: normalizeString(terminalStatus)?.toLowerCase() || run.terminalStatus || null,
    score: normalizeFiniteNumber(score, run.score),
    artifact: normalizeString(artifact) || run.artifact || null,
    summary: normalizeString(summary) || run.summary || null,
    moduleRuns: builtModuleRuns,
  });

  if (!finalizedRun) {
    // normalizeHarnessRun returns null when any moduleRun fails normalization.
    // Preserve valid modules and mark the run as degraded rather than silently losing all data.
    const validModuleRuns = builtModuleRuns.filter(Boolean);
    const invalidCount = builtModuleRuns.length - validModuleRuns.length;
    console.warn(
      `[harness-module-runner] finalizeHarnessRunModules: ${invalidCount} moduleRun(s) failed normalization for automationId=${run.automationId} round=${run.round}; preserving ${validModuleRuns.length} valid modules`,
    );
    finalizedRun = normalizeHarnessRun({
      ...run,
      finalizedAt,
      terminalStatus: normalizeString(terminalStatus)?.toLowerCase() || run.terminalStatus || null,
      score: normalizeFiniteNumber(score, run.score),
      artifact: normalizeString(artifact) || run.artifact || null,
      summary: normalizeString(summary) || run.summary || null,
      moduleRuns: validModuleRuns,
      diagnostics: {
        ...(run.diagnostics || {}),
        warnings: [
          ...((run.diagnostics?.warnings) || []),
          `${invalidCount} module run(s) failed normalization and were dropped`,
        ],
      },
    });
  }

  if (finalizedRun) {
    finalizedRun.reviewerResult = deriveReviewerResultFromModules(finalizedRun, {
      score, artifact, terminalStatus, summary,
    });
  }

  return finalizedRun;
}
