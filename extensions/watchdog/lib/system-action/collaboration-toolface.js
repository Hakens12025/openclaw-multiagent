// collaboration-toolface.js — 协作 FC 工具面 v1(spec §5)。
// L1 入口与 L3 [ACTION] 文本路共享唯一汇合点 systemActionConsume:授权、票据、
// 投递、回流全部复用,这里只做「工具形状 + 受理凭证」两件事。工具按
// collaboration-intent-policy 的 exposedAsTool × 角色授权交集裁剪,授权真源
// 不在本模块。tool_result 是受理凭证(accepted/结构化拒绝),不是执行结果——
// 执行结果走 deferred 票据回流。

import { apiRef, runtimeAgentConfigs } from "../state.js";
import { getAgentRole } from "../agent/agent-identity.js";
import { getTrackingState } from "../store/tracker-store.js";
import { SYSTEM_ACTION_STATUS, isAcceptedSystemActionReceiptStatus } from "../core/runtime-status.js";
import { listExposedToolIntents } from "./collaboration-intent-policy.js";
import { listAllowedActionTypesForRole } from "./system-action-role-policy.js";
import { systemActionConsume } from "./system-action-consumer.js";

const TOOL_DEFINITIONS = Object.freeze({
  assign_task: Object.freeze({
    label: "Assign Task",
    description: "派活:为目标 agent 开一个新的单腿工单(平台代办投递与回流)。任务完成后其结果会经票据回投到你当前会话。参数 targetAgent 填平台里任一存在的 agent id。",
    parameters: {
      type: "object",
      properties: {
        targetAgent: { type: "string", description: "接活 agent 的 id" },
        message: { type: "string", description: "任务原文(对方读到的完整工作指令)" },
        reason: { type: "string", description: "一句派活理由(进唤醒语)" },
        expectations: {
          type: "object",
          description: "验收期望(平台按此审计,考官逐条与会话真值 diff,请如实声明)",
          properties: {
            requiredArtifacts: {
              type: "array",
              description: "应交付产物清单(相对 assignee 工作区的路径)",
              items: {
                type: "object",
                properties: {
                  path: { type: "string" },
                  required: { type: "boolean", description: "缺省 true;false 表示可选产物,缺席只记 waived" },
                },
                required: ["path"],
              },
            },
            expectedActions: {
              type: "array",
              description: "应发起的协作动作(intent 限协作工具面词汇)",
              items: {
                type: "object",
                properties: {
                  intent: { type: "string" },
                  target: { type: "string", description: "动作目标 agent(可选)" },
                  required: { type: "boolean", description: "缺省 true;false 表示可选动作" },
                },
                required: ["intent"],
              },
            },
          },
        },
        phases: {
          type: "array",
          description: "派工先验阶段(可选,按序的阶段名列表,平台据此为对方生成阶段计划)",
          items: { type: "string" },
        },
      },
      required: ["targetAgent", "message"],
    },
  }),
  wake_agent: Object.freeze({
    label: "Wake Agent",
    description: "叫人:最轻的激活原语,只投一句 reason,不开工单、无回流。",
    parameters: {
      type: "object",
      properties: {
        targetAgent: { type: "string", description: "要唤醒的 agent id" },
        reason: { type: "string", description: "唤醒理由(对方看到的一句话)" },
      },
      required: ["targetAgent", "reason"],
    },
  }),
});

// 受理凭证:tool_result 的唯一形状。accepted=true 表示平台已受理并接管投递,
// 不代表对方已完成;拒绝在受理时刻返回,调用方当场可改道。
export function buildCollaborationReceipt(systemActionResult) {
  const status = systemActionResult?.status || null;
  const base = {
    accepted: isAcceptedSystemActionReceiptStatus(status),
    status,
    actionType: systemActionResult?.actionType || null,
    ...(systemActionResult?.targetAgent ? { targetAgent: systemActionResult.targetAgent } : {}),
    ...(systemActionResult?.contractId ? { contractId: systemActionResult.contractId } : {}),
    ...(systemActionResult?.deliveryTicketId ? { deliveryTicketId: systemActionResult.deliveryTicketId } : {}),
  };
  if (base.accepted) {
    // queuePosition(spec §5):排队分支的位次凭证,1 起算;取不到位次时凭证只带布尔 queued。
    const queuePosition = Number.isFinite(systemActionResult?.queuePosition)
      ? systemActionResult.queuePosition
      : null;
    return {
      ...base,
      ...(status === SYSTEM_ACTION_STATUS.QUEUED
        ? { queued: true, ...(queuePosition != null ? { queuePosition } : {}) }
        : {}),
      ...(systemActionResult?.deferredCompletion ? { deferredCompletion: true } : {}),
    };
  }
  // 降级梯子的发现路径就挂在拒绝上。教程刻意不进提示词——它与工具并排会形成竞争性
  // 指令(实测 agent 会在已持有工具的情况下退回写标记)。挂在拒绝里则只在工具真的走
  // 不通时才出现,而且对 readPathScope 受限、读不到工作区文档的角色同样有效。
  //
  // 两级都给:L2 是自完善的 JSON 写法,L3 是动词简写(parseActionLine 先试 JSON,
  // 解析不了再按 `动词 目标 — 文本` 查 ACTION_SHORTHAND_SPECS)。JSON 写不对时
  // 还有一级可落,梯子才是完整的。
  return {
    ...base,
    code: status || "unknown",
    reason: systemActionResult?.error || "action was not accepted",
    fallback: "平台另有文本标记降级协作方式:在产出文件正文之后另起一行写标记。"
      + "结构化写法 [ACTION] {\"type\":\"<intent>\",\"params\":{…}};"
      + "简写 [ACTION] <动词> <目标> — <文本>,动词取 delegate / wake。",
  };
}

function resolveRegisteredRole(agentId) {
  if (!runtimeAgentConfigs.has(agentId)) return null;
  try {
    return getAgentRole(agentId);
  } catch {
    return null;
  }
}

export function buildCollaborationTools({ agentId, sessionKey, api = null, logger }) {
  const role = resolveRegisteredRole(agentId);
  if (!role) return [];
  const allowed = new Set(listAllowedActionTypesForRole(role));
  const intents = listExposedToolIntents().filter((intent) => allowed.has(intent));

  return intents.map((intent) => {
    const definition = TOOL_DEFINITIONS[intent];
    return {
      name: intent,
      label: definition.label,
      description: definition.description,
      parameters: definition.parameters,
      async execute(_toolCallId, params = {}) {
        const result = await systemActionConsume({
          agentId,
          sessionKey,
          contractData: getTrackingState(sessionKey)?.contract || null,
          api: apiRef || api,
          logger,
          injectedAction: { type: intent, params },
        });
        const receipt = buildCollaborationReceipt(result);
        return {
          content: [{ type: "text", text: JSON.stringify(receipt, null, 2) }],
          details: receipt,
        };
      },
    };
  });
}

export function listCollaborationToolNames() {
  return listExposedToolIntents();
}

// 定义表键名(health parity 检查用:定义面必须与意图策略的暴露面一致)。
export function listToolFaceDefinitionNames() {
  return Object.keys(TOOL_DEFINITIONS);
}
