import { materializeTaskStagePlan } from "./task-stage-plan.js";

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
  return materialized || null;
}
