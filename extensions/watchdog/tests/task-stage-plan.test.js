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
} from "../lib/stage/task-stage-plan.js";
import { materializeTaskStageTruth } from "../lib/stage/task-stage-truth.js";

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

// ── 判决面重做(2026-08-10):witness 证人引擎(323 行,按产物/写盘证据反推阶段完成)
// 已整体删除。阶段进度是**记录**:agent 自报走到哪,平台转述。质量核对归 lib/judgment
// 对甲方期望做,不再逆向"从证据猜阶段"。以下锁自报推进的两条边界。──────────────

test("阶段推进按自报:本轮报 completed 即推进当前阶段(恰好一步)", () => {
  const contractId = "TC-DECLARED-ADVANCE";
  const stagePlan = buildInitialTaskStagePlan({ contractId, stages: ["调研", "写作", "复核"] });
  const stageRuntime = buildInitialTaskStageRuntime({ stagePlan });
  const truth = materializeTaskStageTruth({
    contractId,
    stagePlan,
    stageRuntime,
    stageRunResult: { version: 1, status: "completed", summary: "调研完成" },
  });
  assert.equal(truth.stageRuntime.completedStageIds.length, 1);
  assert.equal(truth.stageRuntime.currentStageId, stagePlan.stages[1].id);
});

test("自报指名了别的阶段不推进当前阶段(防跨阶段冒领)", () => {
  const contractId = "TC-DECLARED-WRONG-STAGE";
  const stagePlan = buildInitialTaskStagePlan({ contractId, stages: ["调研", "写作"] });
  const stageRuntime = buildInitialTaskStageRuntime({ stagePlan });
  const truth = materializeTaskStageTruth({
    contractId,
    stagePlan,
    stageRuntime,
    stageRunResult: {
      version: 1,
      status: "completed",
      semanticStageId: stagePlan.stages[1].id, // 报的是第二阶段,当前还在第一
    },
  });
  assert.equal(truth.stageRuntime.completedStageIds.length, 0);
  assert.equal(truth.stageRuntime.currentStageId, stagePlan.stages[0].id);
});
