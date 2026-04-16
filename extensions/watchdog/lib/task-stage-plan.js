import { normalizeString } from "./core/normalize.js";
import { CONTRACT_STATUS } from "./core/runtime-status.js";
import {
  evaluateCurrentStageWitness,
  normalizeStageWitnessObservation,
} from "./stage-witness-engine.js";
import { normalizeStageRunResult } from "./stage-results.js";

function createRevisionPolicy(policy = {}) {
  const normalizedPolicy = policy && typeof policy === "object" ? policy : {};
  return {
    maxRevisions: Number.isFinite(normalizedPolicy.maxRevisions)
      ? Math.max(0, Math.trunc(normalizedPolicy.maxRevisions))
      : 2,
    maxStageDelta: Number.isFinite(normalizedPolicy.maxStageDelta)
      ? Math.max(0, Math.trunc(normalizedPolicy.maxStageDelta))
      : 1,
  };
}

function normalizeStageDefinition(entry) {
  if (typeof entry === "string") {
    const label = normalizeString(entry);
    return label
      ? {
          label,
          semanticLabel: label,
          objective: null,
          deliverable: null,
          completionCriteria: null,
          witness: [],
        }
      : null;
  }

  if (!entry || typeof entry !== "object") {
    return null;
  }

  const label = normalizeString(
    entry.semanticLabel
    || entry.label
    || entry.name
    || entry.objective
    || entry.goal
    || entry.title
    || entry.summary
    || entry.task,
  );
  if (!label) return null;

  return {
    label,
    semanticLabel: normalizeString(entry.semanticLabel) || label,
    objective: normalizeString(entry.objective || entry.goal) || null,
    deliverable: normalizeString(entry.deliverable) || null,
    completionCriteria: normalizeString(entry.completionCriteria || entry.completion) || null,
    witness: Array.isArray(entry.witness) ? [...entry.witness] : [],
  };
}

function normalizeStageDefinitions(stages) {
  return (Array.isArray(stages) ? stages : [])
    .map(normalizeStageDefinition)
    .filter(Boolean);
}

function parseStageIndex(stageId) {
  const match = /^stage-(\d+)$/u.exec(stageId || "");
  return match ? Number.parseInt(match[1], 10) - 1 : -1;
}

function buildCanonicalStages(definitions) {
  return definitions.map((definition, index) => ({
    id: `stage-${index + 1}`,
    label: definition.label,
    semanticLabel: definition.semanticLabel || definition.label,
    objective: definition.objective || null,
    deliverable: definition.deliverable || null,
    completionCriteria: definition.completionCriteria || null,
    witness: Array.isArray(definition.witness) ? [...definition.witness] : [],
  }));
}

function computeStageDelta(previousStages, nextStages) {
  const previousLabels = previousStages.map((entry) => entry.label);
  const nextLabels = nextStages.map((entry) => entry.label);
  const overlap = Math.min(previousLabels.length, nextLabels.length);
  let changed = Math.abs(previousLabels.length - nextLabels.length);
  for (let index = 0; index < overlap; index += 1) {
    if (previousLabels[index] !== nextLabels[index]) {
      changed += 1;
    }
  }
  return changed;
}

function normalizeTaskStagePlan(plan, {
  contractId = null,
  revisionPolicy = null,
} = {}) {
  if (!plan || typeof plan !== "object") return null;

  const canonicalStages = buildCanonicalStages(normalizeStageDefinitions(plan.stages));
  if (canonicalStages.length === 0) return null;

  return {
    contractId: normalizeString(plan.contractId) || normalizeString(contractId),
    version: Number.isFinite(plan.version) ? Math.max(1, Math.trunc(plan.version)) : 1,
    stages: canonicalStages,
    revisionPolicy: createRevisionPolicy(plan.revisionPolicy || revisionPolicy),
  };
}

function listStageIds(stagePlan) {
  return Array.isArray(stagePlan?.stages)
    ? stagePlan.stages.map((entry) => entry.id).filter(Boolean)
    : [];
}

function findNextCurrentStageId(stageIds, completedStageIds, preferredCurrentStageId = null) {
  if (preferredCurrentStageId && stageIds.includes(preferredCurrentStageId) && !completedStageIds.includes(preferredCurrentStageId)) {
    return preferredCurrentStageId;
  }
  return stageIds.find((stageId) => !completedStageIds.includes(stageId)) || null;
}

function isCompletedTerminalStatus(status) {
  return normalizeString(status)?.toLowerCase() === CONTRACT_STATUS.COMPLETED;
}

function hasTerminalCompletedTruth({
  terminalOutcome = null,
} = {}) {
  return isCompletedTerminalStatus(terminalOutcome?.status);
}

function materializeCompletedTerminalStageRuntime(stagePlan, stageRuntime) {
  const normalizedPlan = normalizeTaskStagePlan(stagePlan);
  const normalizedRuntime = materializeTaskStageRuntime({
    stagePlan: normalizedPlan,
    stageRuntime,
  });
  if (!normalizedPlan || !normalizedRuntime) {
    return null;
  }

  return {
    ...normalizedRuntime,
    currentStageId: null,
    completedStageIds: listStageIds(normalizedPlan),
  };
}

export function buildInitialTaskStagePlan({ contractId, stages, revisionPolicy } = {}) {
  const normalizedContractId = normalizeString(contractId);
  const canonicalStages = buildCanonicalStages(normalizeStageDefinitions(stages));
  if (canonicalStages.length === 0) {
    throw new TypeError("buildInitialTaskStagePlan requires non-empty stages");
  }

  return {
    contractId: normalizedContractId,
    version: 1,
    stages: canonicalStages,
    revisionPolicy: createRevisionPolicy(revisionPolicy),
  };
}

export function materializeTaskStagePlan({
  contractId = null,
  stagePlan = null,
  phases = null,
  revisionPolicy = null,
} = {}) {
  if (stagePlan !== undefined && stagePlan !== null) {
    return normalizeTaskStagePlan(stagePlan, {
      contractId,
      revisionPolicy,
    });
  }

  const canonicalStages = buildCanonicalStages(normalizeStageDefinitions(phases));
  if (canonicalStages.length === 0) return null;
  return buildInitialTaskStagePlan({
    contractId,
    stages: canonicalStages,
    revisionPolicy,
  });
}

export function deriveCompatibilityPhases(stagePlan) {
  const normalized = normalizeTaskStagePlan(stagePlan);
  if (!normalized) return [];
  return normalized.stages.map((entry) => entry.label);
}

export function deriveCompatibilityTotal(stagePlan) {
  return deriveCompatibilityPhases(stagePlan).length;
}

export function buildInitialTaskStageRuntime({ stagePlan } = {}) {
  const normalizedPlan = normalizeTaskStagePlan(stagePlan);
  if (!normalizedPlan || normalizedPlan.stages.length === 0) {
    return null;
  }

  return {
    version: 1,
    currentStageId: normalizedPlan.stages[0]?.id || null,
    completedStageIds: [],
    revisionCount: 0,
    lastRevisionReason: null,
  };
}

export function materializeTaskStageRuntime({
  stagePlan = null,
  stageRuntime = null,
} = {}) {
  const normalizedPlan = normalizeTaskStagePlan(stagePlan);
  if (!normalizedPlan || normalizedPlan.stages.length === 0) {
    return null;
  }

  const stageIds = listStageIds(normalizedPlan);
  const completedStageIds = [...new Set((Array.isArray(stageRuntime?.completedStageIds) ? stageRuntime.completedStageIds : [])
    .map(normalizeString)
    .filter((stageId) => stageIds.includes(stageId)))];
  const preferredCurrentStageId = normalizeString(stageRuntime?.currentStageId);

  return {
    version: Number.isFinite(stageRuntime?.version) ? Math.max(1, Math.trunc(stageRuntime.version)) : 1,
    currentStageId: findNextCurrentStageId(stageIds, completedStageIds, preferredCurrentStageId),
    completedStageIds,
    revisionCount: Number.isFinite(stageRuntime?.revisionCount) ? Math.max(0, Math.trunc(stageRuntime.revisionCount)) : 0,
    lastRevisionReason: normalizeString(stageRuntime?.lastRevisionReason) || null,
  };
}

export function applyTaskStageCompletion(stagePlan, stageRuntime, { completedStageId } = {}) {
  const normalizedPlan = normalizeTaskStagePlan(stagePlan);
  const normalizedRuntime = materializeTaskStageRuntime({ stagePlan: normalizedPlan, stageRuntime });
  if (!normalizedPlan || !normalizedRuntime) {
    throw new TypeError("stagePlan and stageRuntime required");
  }

  if (!completedStageId || completedStageId !== normalizedRuntime.currentStageId) {
    throw new Error("completed stage must match current stage");
  }
  if (normalizedRuntime.completedStageIds.includes(completedStageId)) {
    throw new Error("stage already completed");
  }

  const completedStageIds = [...normalizedRuntime.completedStageIds, completedStageId];
  const currentStageId = findNextCurrentStageId(
    listStageIds(normalizedPlan),
    completedStageIds,
    normalizedRuntime.currentStageId,
  );

  return {
    ...normalizedRuntime,
    version: normalizedRuntime.version + 1,
    currentStageId,
    completedStageIds,
  };
}

export function applyTaskStageRevision(stagePlan, stageRuntime, { stages, reason } = {}) {
  const normalizedPlan = normalizeTaskStagePlan(stagePlan);
  const normalizedRuntime = materializeTaskStageRuntime({ stagePlan: normalizedPlan, stageRuntime });
  if (!normalizedPlan || !normalizedRuntime) {
    throw new TypeError("stagePlan and stageRuntime required");
  }

  const nextStageDefinitions = normalizeStageDefinitions(stages);
  if (nextStageDefinitions.length === 0) {
    throw new TypeError("revision requires stages");
  }

  const revisionPolicy = normalizedPlan.revisionPolicy || createRevisionPolicy();
  if (
    revisionPolicy.maxRevisions != null
    && normalizedRuntime.revisionCount >= revisionPolicy.maxRevisions
  ) {
    throw new Error("revision limit reached");
  }

  const nextStages = buildCanonicalStages(nextStageDefinitions);

  for (const completedStageId of normalizedRuntime.completedStageIds) {
    const completedIndex = parseStageIndex(completedStageId);
    const previousLabel = normalizedPlan.stages[completedIndex]?.label;
    const nextLabel = nextStages[completedIndex]?.label;
    if (!previousLabel || !nextLabel || previousLabel !== nextLabel) {
      throw new Error("completed stages are immutable");
    }
  }

  const stageDelta = computeStageDelta(normalizedPlan.stages, nextStages);
  if (stageDelta > revisionPolicy.maxStageDelta) {
    throw new Error("stage delta exceeded");
  }

  const nextPlan = {
    ...normalizedPlan,
    version: normalizedPlan.version + 1,
    stages: nextStages,
  };
  const nextRuntime = materializeTaskStageRuntime({
    stagePlan: nextPlan,
    stageRuntime: {
      ...normalizedRuntime,
      version: normalizedRuntime.version + 1,
      revisionCount: normalizedRuntime.revisionCount + 1,
      lastRevisionReason: normalizeString(reason) || null,
    },
  });

  return {
    stagePlan: nextPlan,
    stageRuntime: nextRuntime,
  };
}

export function materializeTaskStageTruth({
  contractId = null,
  stagePlan = null,
  stageRuntime = null,
  stageRunResult = null,
  executionObservation = null,
  terminalOutcome = null,
  runtimeDiagnostics = null,
  systemActionDelivery = null,
  childContractOutcome = null,
  phases = null,
  revisionPolicy = null,
} = {}) {
  const normalizedPlan = materializeTaskStagePlan({
    contractId,
    stagePlan,
    phases,
    revisionPolicy,
  });
  if (!normalizedPlan) {
    return {
      stagePlan: null,
      stageRuntime: null,
    };
  }

  let nextPlan = normalizedPlan;
  let nextRuntime = materializeTaskStageRuntime({
    stagePlan: nextPlan,
    stageRuntime,
  });
  const stageObservation = normalizeStageWitnessObservation({
    contractId: nextPlan.contractId || contractId,
    executionObservation,
    stageRunResult,
    terminalOutcome,
    runtimeDiagnostics,
    systemActionDelivery,
    childContractOutcome,
  });

  const currentStage = nextRuntime?.currentStageId
    ? nextPlan.stages.find((entry) => entry.id === nextRuntime.currentStageId) || null
    : null;
  if (currentStage) {
    const stageCheckResult = evaluateCurrentStageWitness(currentStage, stageObservation);
    if (stageCheckResult.satisfied && currentStage.id === nextRuntime?.currentStageId) {
      try {
        nextRuntime = applyTaskStageCompletion(nextPlan, nextRuntime, {
          completedStageId: currentStage.id,
        });
      } catch {}
    }
  }

  const normalizedRunResult = normalizeStageRunResult(
    stageRunResult
    || executionObservation?.stageRunResult
    || null,
  );
  if (hasTerminalCompletedTruth({ terminalOutcome, executionObservation })) {
    nextRuntime = materializeCompletedTerminalStageRuntime(nextPlan, nextRuntime);
  }
  if (!normalizedRunResult) {
    return {
      stagePlan: nextPlan,
      stageRuntime: nextRuntime,
    };
  }

  const revision = normalizedRunResult.stagePlanRevision;
  const hasRuntimeRevisionEvidence = Boolean(
    stageObservation.primaryOutputPath
    || stageObservation.artifactPaths.length > 0
    || stageObservation.reviewVerdict
    || stageObservation.systemActionDelivery
    || stageObservation.childContractOutcome,
  );
  if (
    hasRuntimeRevisionEvidence
    && revision
    && Array.isArray(revision.stages)
    && revision.stages.length > 0
  ) {
    try {
      const revisedTruth = applyTaskStageRevision(nextPlan, nextRuntime, {
        stages: revision.stages,
        reason: revision.reason,
      });
      nextPlan = revisedTruth.stagePlan;
      nextRuntime = revisedTruth.stageRuntime;
    } catch {}
  }

  return {
    stagePlan: nextPlan,
    stageRuntime: nextRuntime,
  };
}
