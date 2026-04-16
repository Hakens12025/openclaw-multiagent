import {
  buildInitialTaskStagePlan,
  materializeTaskStagePlan,
} from "./task-stage-plan.js";

// Minimal default — planner agent decides the real stages at runtime.
const DEFAULT_STAGES = Object.freeze(["执行"]);

export function planTaskStages() {
  return [...DEFAULT_STAGES];
}

export function buildTaskStagePlanFromTask({
  contractId = null,
  task = null,
  stagePlan = null,
  phases = null,
  revisionPolicy = null,
} = {}) {
  const materialized = materializeTaskStagePlan({
    contractId,
    stagePlan,
    phases,
    revisionPolicy,
  });
  if (materialized) return materialized;

  const stages = planTaskStages();
  return buildInitialTaskStagePlan({
    contractId,
    stages,
    revisionPolicy,
  });
}
