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
  normalizeFiniteNumber,
  normalizeRecord,
  normalizeString,
} from "./core/normalize.js";
import { classifyRuntimeControlPayload } from "./runtime-user-facing-output.js";

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
      semanticText: requirement.semanticText === true,
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
    if (requirement.semanticText) {
      const raw = await readFile(normalizedPath, "utf8");
      const invalidPayloadReason = classifyRuntimeControlPayload(raw, { outputPath: normalizedPath });
      if (invalidPayloadReason) {
        return {
          ok: false,
          label: requirement.label,
          path: normalizedPath,
          reason: `invalid_semantic_payload:${invalidPayloadReason}`,
        };
      }
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
  const outputPath = normalizeString(contract?.output);
  if (!outputPath) {
    return [];
  }
  return [{
    path: outputPath,
    label: "contract.output",
    nonEmpty: true,
    semanticText: true,
  }];
}

function shouldCheckStageArtifactSemanticText(artifact) {
  const type = normalizeString(artifact?.type)?.toLowerCase() || "";
  return type === "text_output" || type === "notes" || type === "delivery";
}

function buildStageArtifactRequirements(stageRunResult, rawObservation) {
  void rawObservation;
  return (Array.isArray(stageRunResult?.artifacts) ? stageRunResult.artifacts : [])
    .filter((artifact) => artifact?.required !== false)
    .map((artifact) => normalizeArtifactRequirement({
      path: artifact.path,
      label: artifact.label || artifact.type || artifact.path,
      nonEmpty: true,
      semanticText: shouldCheckStageArtifactSemanticText(artifact),
      jsonPaths: Array.isArray(artifact.jsonPaths) ? artifact.jsonPaths : [],
    }))
    .filter(Boolean);
}

function normalizeNullableBoolean(value) {
  if (typeof value === "boolean") return value;
  const s = typeof value === "string" ? value.trim().toLowerCase() : null;
  if (s === "true" || s === "yes" || s === "1") return true;
  if (s === "false" || s === "no" || s === "0") return false;
  return null;
}

function deriveTestsPassed(reviewerResult, verdict) {
  const reviewerTestsPassed = normalizeNullableBoolean(reviewerResult?.testsPassed);
  if (reviewerTestsPassed != null) {
    return reviewerTestsPassed;
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
} = {}) {
  const reviewerResult = normalizeRecord(observation?.reviewerResult, null);
  const verdict = normalizeString(
    reviewerResult?.verdict,
  )?.toLowerCase() || null;
  const summary = normalizeString(
    stageRunResult?.summary
    || stageCompletion?.feedback,
  ) || null;
  const score = normalizeFiniteNumber(
    reviewerResult?.score,
    null,
  );
  const testsPassed = deriveTestsPassed(reviewerResult, verdict);
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
  const stageRunResult = normalizeStageRunResult(observation.stageRunResult);
  const stageCompletion = normalizeStageCompletion(
    observation.stageCompletion,
    stageRunResult?.completion || {},
  );
  const observationEvidence = buildObservationOutcomeEvidence(observation, {
    stageRunResult,
    stageCompletion,
  });

  if (stageRunResult?.status === "failed") {
    return {
      ...observationEvidence,
      status: CONTRACT_STATUS.FAILED,
      reason: stageCompletion?.feedback || stageRunResult.feedback || stageRunResult.summary || "stage reported semantic failure",
      source: "runtime_result",
    };
  }

  if (stageRunResult?.status === "awaiting_input" || stageRunResult?.status === "hold") {
    return {
      ...observationEvidence,
      status: CONTRACT_STATUS.AWAITING_INPUT,
      reason: stageCompletion?.feedback || stageRunResult.feedback || stageRunResult.summary || "stage requested additional input",
      source: "runtime_result",
      clarification: stageCompletion?.feedback || stageRunResult.feedback || stageRunResult.summary || null,
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
      reason: stageRunResult?.summary || stageCompletion?.feedback || `${requirements.length} required artifact(s) verified`,
      source: "completion_criteria",
    };
  }

  if (stageRunResult?.status === "completed") {
    const stageArtifactRequirements = buildStageArtifactRequirements(stageRunResult, executionObservation);
    if (stageArtifactRequirements.length > 0) {
      for (const requirement of stageArtifactRequirements) {
        const check = await inspectArtifact(requirement);
        if (!check.ok) {
          const reason = `${check.label} ${check.reason}`;
          logger?.warn?.(`[watchdog] contract ${contract?.id || "unknown"} completion artifact check failed: ${reason}`);
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
        reason: stageCompletion?.feedback || stageRunResult.summary || stageRunResult.feedback || `${stageArtifactRequirements.length} runtime-observed artifact(s) verified`,
        source: "completion_criteria",
      };
    }
  }

  return {
    ...observationEvidence,
    status: CONTRACT_STATUS.FAILED,
    reason: stageRunResult?.status === "completed" ? "missing required artifact evidence" : "missing runtime_result",
    source: "completion_criteria",
  };
}
