import test from "node:test";
import assert from "node:assert/strict";

import {
  buildTaskStagePlanFromTask,
  planTaskStages,
} from "../lib/task-stage-planner.js";

test("planTaskStages does not invent implicit stages", () => {
  assert.equal(planTaskStages(), null);
});

test("buildTaskStagePlanFromTask returns null when no explicit stage truth is provided", () => {
  const stagePlan = buildTaskStagePlanFromTask({
    contractId: "TC-TEST-MINIMAL",
    task: "任意任务文本",
  });

  assert.equal(stagePlan, null);
});

test("buildTaskStagePlanFromTask still materializes explicit phases", () => {
  const stagePlan = buildTaskStagePlanFromTask({
    contractId: "TC-TEST-PHASES",
    task: "任意任务文本",
    phases: ["准备", "执行"],
  });

  assert.equal(stagePlan?.contractId, "TC-TEST-PHASES");
  assert.deepEqual(stagePlan?.stages.map((entry) => entry.label), ["准备", "执行"]);
});
