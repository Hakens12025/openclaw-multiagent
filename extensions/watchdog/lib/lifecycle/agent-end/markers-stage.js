import { readFile } from "node:fs/promises";

import { broadcast } from "../../transport/sse.js";
import { EVENT_TYPE } from "../../core/event-types.js";
import { recordSynthesizedInternalEvent } from "../../evidence/evidence-bridge.js";
import { buildStagePlanFromMarkers } from "../../stage/stage-marker-parser.js";
import { materializeTaskStagePlan } from "../../stage/task-stage-plan.js";
import { mutateContractById } from "../../contract/contracts.js";

// extract_output_markers 的执行体（自 stage-definitions.js 逐行原样搬出，match() 留在清单里）。
export async function runExtractOutputMarkersStage(context) {
  const contractId = context.executionObservation?.contractId || context.trackingState?.contract?.id || null;
  if (!contractId) return;

  const outputPath = context.executionObservation?.primaryOutputPath || null;
  if (!outputPath) return;

  try {
    context._outputContent = await readFile(outputPath, "utf8");
  } catch { return; }

  const rawPlan = buildStagePlanFromMarkers(context._outputContent);
  const stagePlan = rawPlan?.stages?.length > 0
    ? materializeTaskStagePlan({ contractId, stagePlan: { stages: rawPlan.stages } })
    : null;

  if (stagePlan) {
    const phases = stagePlan.stages.map((s) => s.label);
    // OMIT-11 覆写留痕:已有 stagePlan 被本轮输出标记重建的新 plan 替换时,
    // 追加 internal 合成事件,"计划为何变了"从此在账本可考。旧值取终态链
    // 同款内存镜像(effectiveContractData → trackingState.contract),须在
    // 下方镜像同步覆盖之前捕获;证据写入放 lifecycle 调用点,
    // task-stage-plan 保持纯函数。
    const previousStagePlan = context.effectiveContractData?.stagePlan
      || context.trackingState?.contract?.stagePlan
      || null;
    if (previousStagePlan?.stages?.length > 0) {
      await recordSynthesizedInternalEvent({
        sessionKey: context.sessionKey,
        agentId: context.agentId,
        name: "stage_plan_overwritten",
        args: {
          previousSource: "contract_snapshot",
          nextSource: "output_markers",
          previousStageCount: previousStagePlan.stages.length,
          nextStageCount: stagePlan.stages.length,
        },
        contractId,
        logger: context.logger,
      });
    }
    try {
      await mutateContractById(contractId, context.logger, (c) => {
        c.stagePlan = stagePlan;
        c.phases = phases;
      });
    } catch (error) {
      // DIRECT 信封批②起在 threads 树内有正本(此处容错兜信封索引未落的窗口)——突变缺席不致命,
      // 真值走下方的内存镜像进终态链;绝不让标记提取炸死整条 agent_end。
      context.logger.warn(`[agent-end] contract snapshot mutation skipped for ${contractId}: ${error.message}`);
    }

    // Propagate stages to tracking state + broadcast so dashboard updates immediately
    if (context.trackingState?.contract) {
      context.trackingState.contract.stagePlan = stagePlan;
      context.trackingState.contract.phases = phases;
    }
    broadcast("alert", {
      type: EVENT_TYPE.CONTRACT_STAGE_PLAN_UPDATED,
      contractId,
      phases,
      stagePlan,
      ts: Date.now(),
    });
    context.logger.info(`[agent-end] extracted ${stagePlan.stages.length} stages → contract.stagePlan`);
  }
}
