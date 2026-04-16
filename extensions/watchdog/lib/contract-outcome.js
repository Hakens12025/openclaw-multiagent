// lib/contract-outcome.js — Artifact inspection & contract outcome evaluation

import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { HOME } from "./state.js";
import {
  CONTRACT_STATUS,
} from "./core/runtime-status.js";
import {
  normalizeStageCompletion,
  normalizeStageRunResult,
} from "./stage-results.js";
import { normalizeExecutionObservation } from "./execution-observation.js";
import {
  normalizeBoolean,
  normalizeFiniteNumber,
  normalizeRecord,
  normalizeString,
} from "./core/normalize.js";

function normalizeArtifactRequirement(requirement) {
  if (!requirement) return null;
  if (typeof requirement === "string") {
    return { path: requirement, label: requirement, nonEmpty: false };
  }
  if (typeof requirement === "object" && requirement.path) {
    return {
      path: requirement.path,
      label: requirement.label || requirement.path,
      nonEmpty: requirement.nonEmpty === true,
      jsonPaths: Array.isArray(requirement.jsonPaths) ? requirement.jsonPaths : [],
    };
  }
  return null;
}

function readJsonPath(obj, dottedPath) {
  return String(dottedPath || "")
    .split(".")
    .filter(Boolean)
    .reduce((cursor, key) => (cursor == null ? undefined : cursor[key]), obj);
}

async function inspectArtifact(requirement) {
  const normalizedPath = resolve(String(requirement.path).replace(/^~/, HOME));
  try {
    const fileStat = await stat(normalizedPath);
    if (!fileStat.isFile()) {
      return { ok: false, label: requirement.label, path: normalizedPath, reason: "not_a_file" };
    }
    if (requirement.nonEmpty && fileStat.size <= 0) {
      return { ok: false, label: requirement.label, path: normalizedPath, reason: "empty_file" };
    }
    if (requirement.jsonPaths?.length) {
      const raw = await readFile(normalizedPath, "utf8");
      const parsed = JSON.parse(raw);
      for (const jsonPath of requirement.jsonPaths) {
        if (readJsonPath(parsed, jsonPath) == null) {
          return {
            ok: false,
            label: requirement.label,
            path: normalizedPath,
            reason: `missing_json_path:${jsonPath}`,
          };
        }
      }
    }
    return { ok: true, label: requirement.label, path: normalizedPath };
  } catch (e) {
    return {
      ok: false,
      label: requirement.label,
      path: normalizedPath,
      reason: e.code === "ENOENT" ? "missing_file" : e.message,
    };
  }
}

function buildFallbackRequirements(contract) {
  if (contract?.completionCriteria?.requireDefaultOutputArtifact === false) {
    return [];
  }
  if (contract?.output) {
    return [{ path: contract.output, label: "output", nonEmpty: true }];
  }
  return [];
}

function deriveTestsPassed(reviewerResult, contractResult, verdict) {
  const reviewerTestsPassed = normalizeBoolean(reviewerResult?.testsPassed);
  if (reviewerTestsPassed != null) {
    return reviewerTestsPassed;
  }

  const contractTestsPassed = normalizeBoolean(contractResult?.testsPassed);
  if (contractTestsPassed != null) {
    return contractTestsPassed;
  }

  if (verdict === "pass" || verdict === "improved") {
    return true;
  }
  if (verdict === "fail" || verdict === "regressed") {
    return false;
  }

  return null;
}

function buildObservationOutcomeEvidence(observation, {
  stageRunResult = null,
  stageCompletion = null,
  contractResult = null,
} = {}) {
  const reviewerResult = normalizeRecord(observation?.reviewerResult, null);
  const reportedContractResult = normalizeRecord(contractResult, null);
  const verdict = normalizeString(
    reviewerResult?.verdict
    || reportedContractResult?.verdict,
  )?.toLowerCase() || null;
  const summary = normalizeString(
    stageRunResult?.summary
    || reportedContractResult?.summary
    || reportedContractResult?.detail
    || stageCompletion?.feedback,
  ) || null;
  const score = normalizeFiniteNumber(
    reviewerResult?.score ?? reportedContractResult?.score,
    null,
  );
  const testsPassed = deriveTestsPassed(reviewerResult, reportedContractResult, verdict);
  const artifact = normalizeString(observation?.primaryOutputPath)
    || (Array.isArray(observation?.artifactPaths) ? normalizeString(observation.artifactPaths[0]) : null)
    || null;

  return {
    ...(summary ? { summary } : {}),
    ...(verdict ? { verdict } : {}),
    ...(score != null ? { score } : {}),
    ...(testsPassed != null ? { testsPassed } : {}),
    ...(artifact ? { artifact } : {}),
  };
}

export async function evaluateContractOutcome(contract, executionObservation, logger) {
  const observation = normalizeExecutionObservation(executionObservation, {
    contractId: contract?.id || null,
  });
  const reported = observation.contractResult;
  const reportedStatus = reported?.status;
  const executionTrace = contract?.runtimeDiagnostics?.executionTrace;
  const stageRunResult = normalizeStageRunResult(observation.stageRunResult);
  const stageCompletion = normalizeStageCompletion(
    observation.stageCompletion,
    stageRunResult?.completion || {},
  );
  const observationEvidence = buildObservationOutcomeEvidence(observation, {
    stageRunResult,
    stageCompletion,
    contractResult: reported,
  });

  if (stageRunResult?.status === "failed") {
    return {
      ...observationEvidence,
      status: CONTRACT_STATUS.FAILED,
      reason: stageCompletion?.feedback || stageRunResult.feedback || stageRunResult.summary || "stage reported semantic failure",
      source: "stage_result",
    };
  }

  if (stageRunResult?.status === "awaiting_input" || stageRunResult?.status === "hold") {
    return {
      ...observationEvidence,
      status: CONTRACT_STATUS.AWAITING_INPUT,
      reason: stageCompletion?.feedback || stageRunResult.feedback || stageRunResult.summary || "stage requested additional input",
      source: "stage_result",
      clarification: stageCompletion?.feedback || stageRunResult.feedback || stageRunResult.summary || null,
    };
  }

  if (reportedStatus === CONTRACT_STATUS.FAILED) {
    return {
      ...observationEvidence,
      status: CONTRACT_STATUS.FAILED,
      reason: reported?.detail || reported?.summary || "worker reported semantic failure",
      source: "contract_result",
    };
  }

  if (reportedStatus === CONTRACT_STATUS.AWAITING_INPUT) {
    return {
      ...observationEvidence,
      status: CONTRACT_STATUS.AWAITING_INPUT,
      reason: reported?.detail || reported?.summary || "worker requested additional input",
      source: "contract_result",
      clarification: reported?.clarification || reported?.detail || reported?.summary || null,
    };
  }

  if (contract?._hardPathResult?.status === CONTRACT_STATUS.FAILED && contract?.completionCriteria?.allowHardPathFailure !== true) {
    return {
      ...observationEvidence,
      status: CONTRACT_STATUS.FAILED,
      reason: contract._hardPathResult.error || "hard-path execution failed",
      source: "hard_path",
    };
  }

  const rawRequirements = contract?.completionCriteria?.requiredFiles;
  const requirements = (
    Array.isArray(rawRequirements) && rawRequirements.length > 0
      ? rawRequirements
      : buildFallbackRequirements(contract)
  )
    .map(normalizeArtifactRequirement)
    .filter(Boolean);

  if (requirements.length > 0) {
    for (const requirement of requirements) {
      const check = await inspectArtifact(requirement);
      if (!check.ok) {
        const reason = `${check.label} ${check.reason}`;
        logger?.warn?.(`[watchdog] contract ${contract?.id || "unknown"} semantic check failed: ${reason}`);
        return {
          ...observationEvidence,
          status: CONTRACT_STATUS.FAILED,
          reason,
          source: "completion_criteria",
          artifact: check,
        };
      }
    }
    return {
      ...observationEvidence,
      status: CONTRACT_STATUS.COMPLETED,
      reason: stageRunResult?.summary || stageCompletion?.feedback || reported?.summary || `${requirements.length} required artifact(s) verified`,
      source: "completion_criteria",
    };
  }

  if (stageRunResult?.status === "completed") {
    return {
      ...observationEvidence,
      status: CONTRACT_STATUS.COMPLETED,
      reason: stageCompletion?.feedback || stageRunResult.summary || stageRunResult.feedback || "stage_result captured",
      source: "stage_result",
    };
  }

  if (reportedStatus === CONTRACT_STATUS.COMPLETED) {
    return {
      ...observationEvidence,
      status: CONTRACT_STATUS.COMPLETED,
      reason: reported?.summary || "worker reported completion",
      source: "contract_result",
    };
  }

  if (observation.files.length > 0) {
    return {
      ...observationEvidence,
      status: CONTRACT_STATUS.COMPLETED,
      reason: `${observation.files.length} output file(s) collected`,
      source: "outbox_files",
    };
  }

  if (contract?.output && executionTrace?.outputCommitted === true) {
    return {
      ...observationEvidence,
      status: CONTRACT_STATUS.COMPLETED,
      reason: reported?.summary || "primary output artifact committed",
      source: "execution_trace",
    };
  }

  return {
    ...observationEvidence,
    status: CONTRACT_STATUS.FAILED,
    reason: "no semantic output detected",
    source: "fallback",
  };
}
