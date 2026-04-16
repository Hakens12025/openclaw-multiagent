import { buildReviewerResult } from "./reviewer-result.js";
import {
  normalizeHarnessRun,
} from "./harness-run.js";
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

  return normalizeHarnessRun({
    ...run,
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

  const finalizedRun = normalizeHarnessRun({
    ...run,
    finalizedAt,
    terminalStatus: normalizeString(terminalStatus)?.toLowerCase() || run.terminalStatus || null,
    score: normalizeFiniteNumber(score, run.score),
    artifact: normalizeString(artifact) || run.artifact || null,
    summary: normalizeString(summary) || run.summary || null,
    moduleRuns: listModuleIds(run).map((moduleId) => buildFinalModuleRun(
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
    )),
  });

  if (finalizedRun) {
    finalizedRun.reviewerResult = deriveReviewerResultFromModules(finalizedRun, {
      score, artifact, terminalStatus, summary,
    });
  }

  return finalizedRun;
}
