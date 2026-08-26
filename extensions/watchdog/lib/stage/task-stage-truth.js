// 阶段真值判定:读计划(意图)+ 观测(证据)→ 写 stageRuntime(实际走到哪了)。
//
// 归属产出判决系统(该系统的考官面已于 2026-08-09 拔除待重做),计划定义(stagePlan)
// 归生产系统,住在 lib/stage/task-stage-plan.js。本模块只消费它的公开原语,依赖方向
// 单向(判决 → 生产),生产侧不得反向引用本文件——这条是"判决可拔除"的可验证形态。
//
// 目录说明:按归属本文件该住 lib/evidence/,但跨目录搬迁会让改动触及 4 个非支撑板块,
// 被 scripts/openclaw-block-check.js 判定需先拆任务。真正的债是"判决代码混在计划文件里",
// 抽成独立文件已清偿;跨目录归位留给单独一批。
//
// 阶段推进按 agent 自报(声明式阶段完成)。旧的 witness 证人判定(stage-witness-engine,
// 323 行:按产物/写盘证据反推阶段完成)已随判决面重做删除——阶段进度是**记录**
// (agent 说走到哪了,平台转述),质量核对归 lib/judgment 对着甲方期望做,不在这里。
import { normalizeString } from "../core/normalize.js";
import { CONTRACT_STATUS } from "../core/runtime-status.js";
import {
  applyTaskStageCompletion,
  applyTaskStageRevision,
  materializeTaskStagePlan,
  materializeTaskStageRuntime,
} from "./task-stage-plan.js";
import { normalizeStageRunResult } from "./stage-results.js";

function hasTerminalCompletedTruth(terminalOutcome) {
  return normalizeString(terminalOutcome?.status)?.toLowerCase() === CONTRACT_STATUS.COMPLETED;
}

function materializeCompletedTerminalStageRuntime(stagePlan, stageRuntime) {
  const normalizedPlan = materializeTaskStagePlan({ stagePlan });
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
    completedStageIds: normalizedPlan.stages.map((entry) => entry.id).filter(Boolean),
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
  // 自报推进:本轮 stageRunResult 报了 completed 且指向当前阶段(或未指名)即推进。
  const currentStage = nextRuntime?.currentStageId
    ? nextPlan.stages.find((entry) => entry.id === nextRuntime.currentStageId) || null
    : null;
  if (currentStage) {
    const reported = normalizeStageRunResult(stageRunResult || executionObservation?.stageRunResult || null);
    const reportedStageId = normalizeString(reported?.semanticStageId);
    const stageDeclaredDone = reported?.status === "completed"
      && (!reportedStageId || reportedStageId === currentStage.id);
    if (stageDeclaredDone && currentStage.id === nextRuntime?.currentStageId) {
      try {
        nextRuntime = applyTaskStageCompletion(nextPlan, nextRuntime, {
          completedStageId: currentStage.id,
        });
      } catch {
        // 幂等守卫:该阶段已被更早一轮标记完成时 applyTaskStageCompletion 抛错,
        // 此时保持既有 runtime 就是正确结果。
      }
    }
  }

  const normalizedRunResult = normalizeStageRunResult(
    stageRunResult
    || executionObservation?.stageRunResult
    || null,
  );
  if (hasTerminalCompletedTruth(terminalOutcome)) {
    nextRuntime = materializeCompletedTerminalStageRuntime(nextPlan, nextRuntime);
  }
  if (!normalizedRunResult) {
    return {
      stagePlan: nextPlan,
      stageRuntime: nextRuntime,
    };
  }

  // 计划修订同样是自报(agent 改自己的计划):有修订就应用,不再拿"运行证据"当门。
  const revision = normalizedRunResult.stagePlanRevision;
  if (
    revision
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
    } catch {
      // 改版被修订策略拒绝(次数超限 / 已完成阶段被改名 / delta 超阈)时保留原计划,
      // 拒绝即为判定结果,不是异常。
    }
  }

  return {
    stagePlan: nextPlan,
    stageRuntime: nextRuntime,
  };
}
