import { randomBytes } from "node:crypto";
import { join } from "node:path";

import { annotateExecutionContract } from "../protocol-primitives.js";
import { CONTRACT_STATUS } from "../core/runtime-status.js";
import { CONTROL_PLANE_PATHS } from "../control-plane/control-plane-paths.js";
import { normalizeTerminalOutcome } from "../terminal-outcome.js";
import {
  buildInitialTaskStageRuntime,
  deriveDisplayPhases,
  deriveDisplayTotal,
  materializeTaskStagePlan,
  materializeTaskStageRuntime,
} from "../task-stage-plan.js";

export function buildLoopContractId(now = Date.now()) {
  return `TC-${now}-${randomBytes(3).toString("hex")}`;
}

export function buildLoopStageDescriptor({
  loopId,
  loopSessionId,
  startAgent,
  round,
  stageRuntime,
}) {
  return {
    pipelineId: loopId,
    loopId,
    loopSessionId,
    stage: startAgent,
    round,
    semanticStageId: stageRuntime?.currentStageId || null,
  };
}

export function buildLoopContract({
  contractId,
  loop,
  loopSessionId,
  startAgent,
  requestedTask,
  requestedSource,
  operatorContext,
  replyTo,
  workingDir = null,
  taskStagePlan = null,
  taskStageRuntime = null,
}) {
  const stagePlan = materializeTaskStagePlan({
    contractId,
    stagePlan: taskStagePlan,
  });
  const stageRuntime = stagePlan
    ? (
        materializeTaskStageRuntime({
          stagePlan,
          stageRuntime: taskStageRuntime,
        }) || buildInitialTaskStageRuntime({ stagePlan })
      )
    : null;
  const displayPhases = stagePlan ? deriveDisplayPhases(stagePlan) : null;
  const displayTotal = stagePlan ? deriveDisplayTotal(stagePlan) : null;
  return annotateExecutionContract({
    id: contractId,
    task: requestedTask,
    assignee: startAgent,
    ...(replyTo ? { replyTo } : {}),
    ...(workingDir ? { workingDir } : {}),
    ...(stagePlan ? { stagePlan } : {}),
    ...(stageRuntime ? { stageRuntime } : {}),
    ...(displayPhases ? { phases: displayPhases } : {}),
    ...(displayTotal != null ? { total: displayTotal } : {}),
    output: join(CONTROL_PLANE_PATHS.outputDir, `${contractId}.md`),
    status: CONTRACT_STATUS.PENDING,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    requestedSource: requestedSource || null,
    operatorContext: operatorContext || null,
    pipelineStage: buildLoopStageDescriptor({
      loopId: loop.id,
      loopSessionId,
      startAgent,
      round: 1,
      stageRuntime,
    }),
  }, {
    source: "loop-runtime",
    route: "loop",
  });
}

export function matchesLoopSessionContract(contract, loopSessionId) {
  return contract?.pipelineStage?.loopSessionId === loopSessionId;
}

export function buildInterruptedContractOutcome({
  reason,
  loopId,
  loopSessionId,
  interruptedStage,
}) {
  return normalizeTerminalOutcome({
    status: CONTRACT_STATUS.CANCELLED,
    source: "loop_runtime_interrupt",
    reason: ["loop_interrupted", reason, interruptedStage].filter(Boolean).join(":"),
    summary: `Loop ${loopId || "unknown"} interrupted while ${interruptedStage || "unknown"} was active`,
    artifact: {
      loopId: loopId || null,
      loopSessionId: loopSessionId || null,
      interruptedStage: interruptedStage || null,
    },
  }, {
    terminalStatus: CONTRACT_STATUS.CANCELLED,
  });
}
