import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

import { normalizeExecutionObservation } from "./execution-observation.js";
import { normalizeTerminalOutcome } from "./terminal-outcome.js";
import {
  normalizeRecord,
  normalizeString,
} from "./core/normalize.js";

function readJsonPath(obj, dottedPath) {
  return String(dottedPath || "")
    .split(".")
    .filter(Boolean)
    .reduce((cursor, key) => (cursor == null ? undefined : cursor[key]), obj);
}

function normalizeWitnessKind(value) {
  return normalizeString(value)?.toLowerCase() || null;
}

function normalizeExpectedVerdict(value) {
  return normalizeString(value)?.toLowerCase() || null;
}

function normalizeArtifactJsonPaths(rule) {
  return (Array.isArray(rule?.jsonPaths) ? rule.jsonPaths : [rule?.jsonPath])
    .map((entry) => normalizeString(entry))
    .filter(Boolean);
}

function normalizeStageWitnessRule(value) {
  const source = normalizeRecord(value, null);
  if (!source) return null;

  const kind = normalizeWitnessKind(source.kind);
  if (!kind) return null;

  return {
    kind,
    path: normalizeString(source.path) || null,
    pathRef: normalizeString(source.pathRef) || null,
    nonEmpty: source.nonEmpty === true,
    jsonPaths: normalizeArtifactJsonPaths(source),
    expected: normalizeString(source.expected) || null,
    workflow: normalizeString(source.workflow) || null,
    status: normalizeString(source.status) || null,
    contractId: normalizeString(source.contractId || source.childContractId) || null,
  };
}

function normalizeArtifact(value) {
  return normalizeString(value);
}

function collectArtifactPaths(observation, terminalOutcome) {
  return [...new Set([
    ...(Array.isArray(observation?.artifactPaths) ? observation.artifactPaths : []),
    normalizeArtifact(observation?.primaryOutputPath),
    normalizeArtifact(terminalOutcome?.artifact),
  ].filter(Boolean))];
}

function normalizeReviewVerdict({ executionObservation, terminalOutcome, runtimeDiagnostics }) {
  return normalizeExpectedVerdict(
    executionObservation?.reviewerResult?.verdict
    || executionObservation?.reviewVerdict?.verdict
    || terminalOutcome?.verdict
    || runtimeDiagnostics?.systemActionDelivery?.system_action_review_verdict?.verdict,
  );
}

function normalizeChildContractOutcome(childContractOutcome, runtimeDiagnostics, systemActionDelivery) {
  return normalizeRecord(
    childContractOutcome
    || runtimeDiagnostics?.childContractOutcome
    || runtimeDiagnostics?.delegation?.childContractOutcome
    || systemActionDelivery?.childContractOutcome,
    null,
  );
}

function normalizeSystemActionDelivery(systemActionDelivery, runtimeDiagnostics) {
  return normalizeRecord(
    systemActionDelivery
    || runtimeDiagnostics?.systemActionDelivery,
    null,
  );
}

function resolveArtifactPath(rule, observation) {
  if (rule.path) {
    return rule.path;
  }

  const normalizedRef = normalizeWitnessKind(rule.pathRef);
  if (!normalizedRef || normalizedRef === "primary_output") {
    return observation.primaryOutputPath || null;
  }
  if (normalizedRef === "artifact" || normalizedRef === "any_artifact") {
    return observation.artifactPaths[0] || observation.primaryOutputPath || null;
  }
  return observation.primaryOutputPath || observation.artifactPaths[0] || null;
}

function fileWitnessSatisfied(path, {
  nonEmpty = false,
  jsonPaths = [],
} = {}) {
  try {
    const stats = statSync(resolve(path));
    if (!stats.isFile()) return false;
    if (nonEmpty && stats.size <= 0) return false;
    if (jsonPaths.length === 0) return true;

    const parsed = JSON.parse(readFileSync(resolve(path), "utf8"));
    return jsonPaths.every((jsonPath) => readJsonPath(parsed, jsonPath) != null);
  } catch {
    return false;
  }
}

function evaluateArtifactWitness(rule, observation) {
  const artifactPath = resolveArtifactPath(rule, observation);
  if (!artifactPath) return null;
  if (!fileWitnessSatisfied(artifactPath, {
    nonEmpty: rule.nonEmpty,
    jsonPaths: rule.jsonPaths,
  })) {
    return null;
  }

  return {
    kind: rule.kind,
    source: "execution_observation.artifact",
    path: artifactPath,
  };
}

function evaluateReviewVerdictWitness(rule, observation) {
  const verdict = observation.reviewVerdict;
  const expected = normalizeExpectedVerdict(rule.expected) || "pass";
  if (!verdict || verdict !== expected) {
    return null;
  }

  return {
    kind: rule.kind,
    source: "execution_observation.reviewer_result",
    verdict,
  };
}

function evaluateSystemActionDeliveryWitness(rule, observation) {
  const delivery = observation.systemActionDelivery;
  if (!delivery) return null;

  const workflow = normalizeString(delivery.semanticWorkflow || delivery.workflow) || null;
  const status = normalizeString(
    delivery.status
    || observation.runtimeDiagnostics?.deliveryStatus
    || observation.runtimeDiagnostics?.systemActionDelivery?.status,
  ) || null;

  if (rule.workflow && workflow !== rule.workflow) {
    return null;
  }
  if (rule.status && status !== rule.status) {
    return null;
  }

  return {
    kind: rule.kind,
    source: "system_action_delivery",
    workflow,
    status,
  };
}

function evaluateChildContractTerminalWitness(rule, observation) {
  const outcome = observation.childContractOutcome;
  if (!outcome) return null;

  const contractId = normalizeString(outcome.contractId) || null;
  const status = normalizeString(outcome.status || outcome.terminalStatus) || null;
  if (rule.contractId && contractId !== rule.contractId) {
    return null;
  }
  if (rule.status && status !== rule.status) {
    return null;
  }

  return {
    kind: rule.kind,
    source: "child_contract_terminal",
    contractId,
    status,
  };
}

function evaluateWitnessRule(rule, observation) {
  switch (rule.kind) {
    case "artifact_exists":
    case "artifact_json_path":
      return evaluateArtifactWitness(rule, observation);
    case "review_verdict":
      return evaluateReviewVerdictWitness(rule, observation);
    case "system_action_delivery":
      return evaluateSystemActionDeliveryWitness(rule, observation);
    case "child_contract_terminal":
      return evaluateChildContractTerminalWitness(rule, observation);
    default:
      return null;
  }
}

function evaluateSystemOwnedObservationWitness(observation) {
  if (observation.primaryOutputPath || observation.artifactPaths.length > 0) {
    return {
      kind: "system_owned_observation",
      source: "execution_observation.artifact",
    };
  }
  if (observation.reviewVerdict) {
    return {
      kind: "system_owned_observation",
      source: "execution_observation.reviewer_result",
      verdict: observation.reviewVerdict,
    };
  }
  if (observation.systemActionDelivery) {
    return {
      kind: "system_owned_observation",
      source: "system_action_delivery",
    };
  }
  return null;
}

export function normalizeStageWitnessObservation({
  contractId = null,
  executionObservation = null,
  stageRunResult = null,
  terminalOutcome = null,
  runtimeDiagnostics = null,
  systemActionDelivery = null,
  childContractOutcome = null,
} = {}) {
  const normalizedExecutionObservation = normalizeExecutionObservation(
    executionObservation || (stageRunResult ? { stageRunResult } : null),
    { contractId },
  );
  const normalizedRuntimeDiagnostics = normalizeRecord(runtimeDiagnostics, null);
  const normalizedSystemActionDelivery = normalizeSystemActionDelivery(systemActionDelivery, normalizedRuntimeDiagnostics);
  const normalizedTerminalOutcome = terminalOutcome
    ? normalizeTerminalOutcome(terminalOutcome, {
        terminalStatus: terminalOutcome?.status || null,
      })
    : null;
  const artifactPaths = collectArtifactPaths(normalizedExecutionObservation, normalizedTerminalOutcome);
  const primaryOutputPath = normalizeArtifact(normalizedExecutionObservation.primaryOutputPath)
    || normalizeArtifact(normalizedTerminalOutcome?.artifact)
    || artifactPaths[0]
    || null;

  return {
    contractId: normalizedExecutionObservation.contractId || normalizeString(contractId) || null,
    executionObservation: normalizedExecutionObservation,
    terminalOutcome: normalizedTerminalOutcome,
    runtimeDiagnostics: normalizedRuntimeDiagnostics,
    systemActionDelivery: normalizedSystemActionDelivery,
    childContractOutcome: normalizeChildContractOutcome(
      childContractOutcome,
      normalizedRuntimeDiagnostics,
      normalizedSystemActionDelivery,
    ),
    artifactPaths,
    primaryOutputPath,
    reviewVerdict: normalizeReviewVerdict({
      executionObservation: normalizedExecutionObservation,
      terminalOutcome: normalizedTerminalOutcome,
      runtimeDiagnostics: normalizedRuntimeDiagnostics,
    }),
  };
}

export function evaluateCurrentStageWitness(stageDefinition, observationInput) {
  const observation = normalizeStageWitnessObservation(observationInput);
  const witnessRules = (Array.isArray(stageDefinition?.witness) ? stageDefinition.witness : [])
    .map(normalizeStageWitnessRule)
    .filter(Boolean);

  if (witnessRules.length === 0) {
    const matched = evaluateSystemOwnedObservationWitness(observation);
    return {
      stageId: normalizeString(stageDefinition?.id) || null,
      satisfied: Boolean(matched),
      matchedWitnesses: matched ? [matched] : [],
      reason: matched ? "system_owned_observation_satisfied" : "system_owned_observation_missing",
    };
  }

  const matchedWitnesses = [];
  for (const witnessRule of witnessRules) {
    const matchedWitness = evaluateWitnessRule(witnessRule, observation);
    if (!matchedWitness) {
      return {
        stageId: normalizeString(stageDefinition?.id) || null,
        satisfied: false,
        matchedWitnesses,
        reason: `missing_witness:${witnessRule.kind}`,
      };
    }
    matchedWitnesses.push(matchedWitness);
  }

  return {
    stageId: normalizeString(stageDefinition?.id) || null,
    satisfied: true,
    matchedWitnesses,
    reason: "required_witnesses_satisfied",
  };
}
