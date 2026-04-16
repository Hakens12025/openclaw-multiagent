import {
  materializeTaskStageTruth,
  deriveCompatibilityPhases,
  deriveCompatibilityTotal,
} from "./task-stage-plan.js";

export function buildLifecycleStageTruth(contract) {
  const truth = materializeTaskStageTruth({
    contractId: contract?.id || contract?.contractId || null,
    stagePlan: contract?.stagePlan,
    stageRuntime: contract?.stageRuntime,
    executionObservation: contract?.executionObservation,
    terminalOutcome: contract?.terminalOutcome,
    runtimeDiagnostics: contract?.runtimeDiagnostics,
    systemActionDelivery: contract?.systemActionDelivery,
    phases: contract?.phases,
  });
  const stagePlan = truth.stagePlan;

  if (!stagePlan) {
    return {};
  }

  return {
    stagePlan,
    stageRuntime: truth.stageRuntime,
    phases: deriveCompatibilityPhases(stagePlan),
    total: deriveCompatibilityTotal(stagePlan),
  };
}
