import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  buildInitialTaskStagePlan,
  buildInitialTaskStageRuntime,
  applyTaskStageCompletion,
  applyTaskStageRevision,
  materializeTaskStageTruth,
} from "../lib/task-stage-plan.js";

test("buildInitialTaskStagePlan returns a definition-only canonical plan", () => {
  const plan = buildInitialTaskStagePlan({
    contractId: "TC-stage-1",
    stages: ["  建立比较维度  ", { name: " 补充关键证据 " }, "形成结论"],
  });

  assert.equal(plan.contractId, "TC-stage-1");
  assert.equal(plan.version, 1);
  assert.ok(!("currentStageId" in plan));
  assert.ok(!("completedStageIds" in plan));
  assert.deepEqual(
    plan.stages.map((entry) => ({ id: entry.id, label: entry.label })),
    [
      { id: "stage-1", label: "建立比较维度" },
      { id: "stage-2", label: "补充关键证据" },
      { id: "stage-3", label: "形成结论" },
    ],
  );

  const withoutContractId = buildInitialTaskStagePlan({
    stages: ["建立比较维度", "补充关键证据"],
  });
  assert.equal(withoutContractId.contractId, null);
});

test("buildInitialTaskStagePlan normalizes planner phase objects through objective-like fields", () => {
  const plan = buildInitialTaskStagePlan({
    contractId: "TC-stage-planner-objective",
    stages: [
      { agentId: "researcher", objective: "建立比较维度" },
      { agentId: "worker-d", goal: "补充关键证据" },
      { agentId: "evaluator", title: "形成结论" },
    ],
  });

  assert.deepEqual(
    plan.stages.map((entry) => entry.label),
    ["建立比较维度", "补充关键证据", "形成结论"],
  );
});

test("applyTaskStageCompletion advances stageRuntime without mutating definition-only stagePlan", () => {
  const stagePlan = buildInitialTaskStagePlan({
    contractId: "TC-stage-2",
    stages: ["建立比较维度", "补充关键证据", "形成结论"],
  });
  const initial = buildInitialTaskStageRuntime({ stagePlan });

  const next = applyTaskStageCompletion(stagePlan, initial, {
    completedStageId: initial.currentStageId,
  });

  assert.deepEqual(next.completedStageIds, [initial.currentStageId]);
  assert.equal(next.currentStageId, stagePlan.stages[1].id);
  assert.deepEqual(
    stagePlan.stages.map((entry) => ({ id: entry.id, label: entry.label })),
    [
      { id: "stage-1", label: "建立比较维度" },
      { id: "stage-2", label: "补充关键证据" },
      { id: "stage-3", label: "形成结论" },
    ],
  );
  assert.deepEqual(initial.completedStageIds, []);
});

test("applyTaskStageRevision rejects rewrites that rename completed stages or exceed stage delta", () => {
  const stagePlan = buildInitialTaskStagePlan({
    contractId: "TC-stage-3",
    stages: ["建立比较维度", "补充关键证据", "形成结论"],
    revisionPolicy: { maxRevisions: 2, maxStageDelta: 1 },
  });
  const initial = buildInitialTaskStageRuntime({ stagePlan });
  const progressed = applyTaskStageCompletion(stagePlan, initial, {
    completedStageId: initial.currentStageId,
  });

  assert.throws(() =>
    applyTaskStageRevision(stagePlan, progressed, {
      reason: "rewrite_completed_history",
      stages: ["重新定义范围", "补充关键证据", "形成结论"],
    }),
  );

  assert.throws(() =>
    applyTaskStageRevision(stagePlan, progressed, {
      reason: "explode_stage_count",
      stages: [
        "建立比较维度",
        "补充证据A",
        "补充证据B",
        "整理证据",
      ],
    }),
  );

  const noReasonRevision = applyTaskStageRevision(stagePlan, progressed, {
    stages: ["建立比较维度", "补充关键证据", "形成结论"],
  });
  assert.equal(noReasonRevision.stageRuntime.lastRevisionReason, null);
});

test("applyTaskStageRevision enforces maxRevisions", () => {
  const stagePlan = buildInitialTaskStagePlan({
    stages: ["建立比较维度", "补充关键证据", "形成结论"],
    revisionPolicy: { maxRevisions: 1, maxStageDelta: 1 },
  });
  const initial = buildInitialTaskStageRuntime({ stagePlan });

  const revised = applyTaskStageRevision(stagePlan, initial, {
    stages: ["建立比较维度", "补充关键证据", "形成结论"],
  });
  assert.equal(revised.stageRuntime.revisionCount, 1);

  assert.throws(() =>
    applyTaskStageRevision(revised.stagePlan, revised.stageRuntime, {
      stages: ["建立比较维度", "补充关键证据", "形成结论"],
    }),
  );
});

test("materializeTaskStageTruth advances exactly one stage from artifact witness without semantic self-report", async () => {
  const artifactDir = await mkdtemp(join(tmpdir(), "openclaw-stage-witness-artifact-"));
  const artifactPath = join(artifactDir, "result.md");
  const stagePlan = buildInitialTaskStagePlan({
    contractId: "TC-stage-witness-artifact",
    stages: [
      {
        label: "收集证据",
        witness: [{ kind: "artifact_exists", pathRef: "primary_output", nonEmpty: true }],
      },
      {
        label: "形成结论",
        witness: [{ kind: "review_verdict", expected: "pass" }],
      },
    ],
  });
  const initialRuntime = buildInitialTaskStageRuntime({ stagePlan });

  try {
    await writeFile(artifactPath, "# result\n", "utf8");

    const truth = materializeTaskStageTruth({
      contractId: "TC-stage-witness-artifact",
      stagePlan,
      stageRuntime: initialRuntime,
      executionObservation: {
        collected: true,
        contractId: "TC-stage-witness-artifact",
        primaryOutputPath: artifactPath,
        artifactPaths: [artifactPath],
      },
    });

    assert.deepEqual(truth.stageRuntime?.completedStageIds, ["stage-1"]);
    assert.equal(truth.stageRuntime?.currentStageId, "stage-2");
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
  }
});

test("materializeTaskStageTruth advances exactly one stage from review witness without semantic self-report", () => {
  const stagePlan = buildInitialTaskStagePlan({
    contractId: "TC-stage-witness-review",
    stages: [
      {
        label: "代码审查",
        witness: [{ kind: "review_verdict", expected: "pass" }],
      },
      {
        label: "形成结论",
        witness: [{ kind: "artifact_exists", pathRef: "primary_output", nonEmpty: true }],
      },
    ],
  });
  const initialRuntime = buildInitialTaskStageRuntime({ stagePlan });

  const truth = materializeTaskStageTruth({
    contractId: "TC-stage-witness-review",
    stagePlan,
    stageRuntime: initialRuntime,
    executionObservation: {
      collected: true,
      contractId: "TC-stage-witness-review",
      reviewerResult: {
        verdict: "pass",
      },
    },
  });

  assert.deepEqual(truth.stageRuntime?.completedStageIds, ["stage-1"]);
  assert.equal(truth.stageRuntime?.currentStageId, "stage-2");
});

test("materializeTaskStageTruth advances exactly one stage from system-owned artifact observation without explicit witness", async () => {
  const artifactDir = await mkdtemp(join(tmpdir(), "openclaw-stage-system-observer-"));
  const artifactPath = join(artifactDir, "result.md");
  const stagePlan = buildInitialTaskStagePlan({
    contractId: "TC-stage-system-observer-artifact",
    stages: ["收集证据", "形成结论"],
  });
  const initialRuntime = buildInitialTaskStageRuntime({ stagePlan });

  try {
    await writeFile(artifactPath, "# result\n", "utf8");

    const truth = materializeTaskStageTruth({
      contractId: "TC-stage-system-observer-artifact",
      stagePlan,
      stageRuntime: initialRuntime,
      executionObservation: {
        collected: true,
        contractId: "TC-stage-system-observer-artifact",
        primaryOutputPath: artifactPath,
        artifactPaths: [artifactPath],
      },
    });

    assert.deepEqual(truth.stageRuntime?.completedStageIds, ["stage-1"]);
    assert.equal(truth.stageRuntime?.currentStageId, "stage-2");
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
  }
});

test("materializeTaskStageTruth does not advance from semantic self-report alone when witness is unsatisfied", () => {
  const stagePlan = buildInitialTaskStagePlan({
    contractId: "TC-stage-witness-no-self-report",
    stages: [
      {
        label: "收集证据",
        witness: [{ kind: "artifact_exists", pathRef: "primary_output", nonEmpty: true }],
      },
      {
        label: "形成结论",
      },
    ],
  });
  const initialRuntime = buildInitialTaskStageRuntime({ stagePlan });

  const truth = materializeTaskStageTruth({
    contractId: "TC-stage-witness-no-self-report",
    stagePlan,
    stageRuntime: initialRuntime,
    stageRunResult: {
      status: "completed",
      semanticStageId: "stage-1",
      semanticStageAction: "complete",
    },
  });

  assert.deepEqual(truth.stageRuntime?.completedStageIds, []);
  assert.equal(truth.stageRuntime?.currentStageId, "stage-1");
});

test("materializeTaskStageTruth does not let later-stage witness skip the current stage", () => {
  const stagePlan = buildInitialTaskStagePlan({
    contractId: "TC-stage-witness-no-skip",
    stages: [
      {
        label: "收集证据",
        witness: [{ kind: "artifact_exists", pathRef: "primary_output", nonEmpty: true }],
      },
      {
        label: "代码审查",
        witness: [{ kind: "review_verdict", expected: "pass" }],
      },
    ],
  });
  const initialRuntime = buildInitialTaskStageRuntime({ stagePlan });

  const truth = materializeTaskStageTruth({
    contractId: "TC-stage-witness-no-skip",
    stagePlan,
    stageRuntime: initialRuntime,
    executionObservation: {
      collected: true,
      contractId: "TC-stage-witness-no-skip",
      reviewerResult: {
        verdict: "pass",
      },
    },
  });

  assert.deepEqual(truth.stageRuntime?.completedStageIds, []);
  assert.equal(truth.stageRuntime?.currentStageId, "stage-1");
});

test("materializeTaskStageTruth does not apply stagePlanRevision from self-report alone without runtime witness", () => {
  const stagePlan = buildInitialTaskStagePlan({
    contractId: "TC-stage-revision-no-witness",
    stages: ["收集证据", "形成结论"],
  });
  const initialRuntime = buildInitialTaskStageRuntime({ stagePlan });

  const truth = materializeTaskStageTruth({
    contractId: "TC-stage-revision-no-witness",
    stagePlan,
    stageRuntime: initialRuntime,
    stageRunResult: {
      status: "completed",
      stagePlanRevision: {
        reason: "rewrite without runtime evidence",
        stages: ["改写历史", "形成结论"],
      },
    },
  });

  assert.deepEqual(
    truth.stagePlan?.stages?.map((entry) => entry.label),
    ["收集证据", "形成结论"],
  );
  assert.deepEqual(truth.stageRuntime?.completedStageIds, []);
  assert.equal(truth.stageRuntime?.currentStageId, "stage-1");
});

test("materializeTaskStageTruth marks all planned stages completed when contract reaches terminal completed", () => {
  const stagePlan = buildInitialTaskStagePlan({
    contractId: "TC-stage-terminal-completed",
    stages: ["框架调研与资料收集", "多维度对比分析", "报告整合与输出"],
  });
  const initialRuntime = buildInitialTaskStageRuntime({ stagePlan });

  const truth = materializeTaskStageTruth({
    contractId: "TC-stage-terminal-completed",
    stagePlan,
    stageRuntime: initialRuntime,
    terminalOutcome: {
      status: "completed",
      reason: "artifacts verified",
      source: "completion_criteria",
    },
    executionObservation: {
      collected: true,
      contractId: "TC-stage-terminal-completed",
      stageCompletion: {
        status: "completed",
      },
    },
  });

  assert.deepEqual(
    truth.stageRuntime?.completedStageIds,
    ["stage-1", "stage-2", "stage-3"],
  );
  assert.equal(truth.stageRuntime?.currentStageId, null);
});
