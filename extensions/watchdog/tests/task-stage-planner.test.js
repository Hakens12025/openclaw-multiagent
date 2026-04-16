import test from "node:test";
import assert from "node:assert/strict";

import {
  buildTaskStagePlanFromTask,
  planTaskStages,
} from "../lib/task-stage-planner.js";

test("planTaskStages returns minimal default stage", () => {
  assert.deepEqual(planTaskStages(), ["执行"]);
});

test("buildTaskStagePlanFromTask produces a valid single-stage plan", () => {
  const stagePlan = buildTaskStagePlanFromTask({
    contractId: "TC-TEST-MINIMAL",
    task: "任意任务文本",
  });

  assert.equal(stagePlan?.contractId, "TC-TEST-MINIMAL");
  assert.equal(stagePlan?.stages?.length, 1);
  assert.equal(stagePlan?.stages?.[0]?.label, "执行");
});
