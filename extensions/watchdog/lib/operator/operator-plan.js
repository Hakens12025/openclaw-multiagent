import {
  findMissingRequiredCliSystemSurfaceFields,
  normalizeCliSystemSurfacePayload,
} from "../cli-system/cli-surface-registry.js";
import { isOperatorExecutableSurfaceId } from "./operator-surface-policy.js";
import { normalizeOrderedStringArray, normalizeRecord, normalizeString, uniqueStrings } from "../core/normalize.js";

export const OPERATOR_PLAN_INTENTS = Object.freeze([
  "create_agent",
  "connect_agents",
  "disconnect_agents",
  "agent_mutation",
  "graph_mutation",
  "platform_mutation",
  "advice_only",
  "unsupported",
]);

export const EXECUTABLE_OPERATOR_PLAN_INTENTS = new Set(
  OPERATOR_PLAN_INTENTS.filter((intent) => !["advice_only", "unsupported"].includes(intent)),
);

function normalizeText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function normalizeTextList(value) {
  return Array.isArray(value)
    ? uniqueStrings(value.map((item) => normalizeText(item)).filter(Boolean))
    : [];
}

function looksLikeQuestionRequest(text) {
  return /[？?]/.test(text)
    || /(为什么|为何|是什么|啥是|区别|怎么|如何|要不要|能不能|可不可以|why|what is|difference|how)/i.test(text);
}

function looksLikeExplicitActionDirective(text) {
  return /(创建|新建|建立|新增|加一个|做一个|create|add|配置|设置|修改|更新|调整|优化|整理|修|修复|repair|optimize|improve|tune|连接|连到|连线|断开|删除边|移除连接|帮我|请把|请给)/i.test(text);
}

function shouldPreferAdviceOnly(requestText, intent) {
  const normalized = normalizeText(requestText);
  if (!normalized) return false;
  if (!looksLikeQuestionRequest(normalized)) return false;
  if (looksLikeExplicitActionDirective(normalized)) return false;
  return ["connect_agents", "disconnect_agents", "graph_mutation", "platform_mutation", "agent_mutation"].includes(intent);
}

function mergeDerivedValue(derived, key, value) {
  const normalized = normalizeString(value);
  if (normalized) {
    derived[key] = normalized;
  } else if (!(key in derived)) {
    derived[key] = null;
  }
}

function mergeAgentDerivedFields(derived, payload, mappings) {
  for (const [derivedKey, payloadKeys] of Object.entries(mappings)) {
    const value = payloadKeys
      .map((payloadKey) => payload[payloadKey])
      .find((candidate) => normalizeString(candidate));
    mergeDerivedValue(derived, derivedKey, value);
  }
}

function collectEdgeDerivedFields(edges, payload) {
  const from = normalizeString(payload.from);
  const to = normalizeString(payload.to);
  if (from && to) {
    edges.push({ from, to });
  }
}

function collectPlanDerivedFieldsFromStep(step, derived, edges) {
  const payload = normalizeRecord(step?.payload);
  const surfaceId = normalizeString(step?.surfaceId);
  const agentFieldExtractors = {
    "agents.create": {
      agentId: ["agentId", "id"],
      role: ["role"],
      model: ["model"],
    },
    "agents.name": {
      agentId: ["agentId"],
      displayName: ["name"],
    },
    "agents.description": {
      agentId: ["agentId"],
      description: ["description"],
    },
  };

  if (agentFieldExtractors[surfaceId]) {
    mergeAgentDerivedFields(derived, payload, agentFieldExtractors[surfaceId]);
    return;
  }

  if (surfaceId === "agents.skills") {
    mergeDerivedValue(derived, "agentId", payload.agentId);
    derived.requestedSkills = uniqueStrings([
      ...(Array.isArray(derived.requestedSkills) ? derived.requestedSkills : []),
      ...normalizeOrderedStringArray(payload.skills),
    ]);
    return;
  }

  if (surfaceId === "graph.edge.add" || surfaceId === "graph.edge.delete") {
    collectEdgeDerivedFields(edges, payload);
    return;
  }

  if (surfaceId === "graph.loop.compose") {
    const agentIds = normalizeOrderedStringArray(payload.agents);
    if (agentIds.length > 0) {
      derived.agentIds = agentIds;
    }
    return;
  }

  if (surfaceId === "graph.loop.repair" || surfaceId === "runtime.loop.interrupt") {
    mergeDerivedValue(derived, "loopId", payload.loopId);
    return;
  }

  if (surfaceId === "runtime.loop.resume") {
    mergeDerivedValue(derived, "loopId", payload.loopId);
    mergeDerivedValue(derived, "startStage", payload.startStage);
  }
}

function collectPlanDerivedFields(steps, derived) {
  const nextDerived = {
    ...normalizeRecord(derived),
  };
  const edges = [];

  for (const step of Array.isArray(steps) ? steps : []) {
    collectPlanDerivedFieldsFromStep(step, nextDerived, edges);
  }

  if (edges.length > 0) {
    nextDerived.fromAgentId = edges[0].from || nextDerived.fromAgentId || null;
    nextDerived.toAgentId = edges[0].to || nextDerived.toAgentId || null;
    if (edges.length === 2) {
      nextDerived.bidirectional = edges[0].from === edges[1].to && edges[0].to === edges[1].from;
    } else if (nextDerived.bidirectional == null) {
      nextDerived.bidirectional = false;
    }
  }

  return nextDerived;
}

function validatePlanStep(step, index) {
  const source = normalizeRecord(step);
  const surfaceId = normalizeString(source.surfaceId);
  if (!surfaceId || !isOperatorExecutableSurfaceId(surfaceId)) {
    throw new Error(`unsupported operator step at index ${index}`);
  }
  const payload = normalizeCliSystemSurfacePayload(surfaceId, normalizeRecord(source.payload));
  const missingFields = findMissingRequiredCliSystemSurfaceFields(surfaceId, payload);
  if (missingFields.length > 0) {
    throw new Error(
      `operator step at index ${index} is missing required fields: ${missingFields.map((field) => field.key).join(", ")}`,
    );
  }
  return {
    surfaceId,
    title: normalizeString(source.title) || surfaceId,
    summary: normalizeString(source.summary) || null,
    payload,
  };
}

export function buildPlanResponse({
  intent,
  reply,
  summary,
  warnings = [],
  limitations = [],
  assumptions = [],
  derived = {},
  steps = [],
} = {}) {
  const normalizedIntent = normalizeString(intent) || "advice_only";
  return {
    ok: true,
    intent: normalizedIntent,
    supportedIntents: OPERATOR_PLAN_INTENTS,
    canExecute: steps.length > 0 && EXECUTABLE_OPERATOR_PLAN_INTENTS.has(normalizedIntent),
    reply: normalizeString(reply) || null,
    plan: {
      intent: normalizedIntent,
      summary: normalizeString(summary) || "operator plan",
      reply: normalizeString(reply) || null,
      steps,
      warnings: normalizeTextList(warnings),
      limitations: normalizeTextList(limitations),
      assumptions: normalizeTextList(assumptions),
      derived: normalizeRecord(derived),
    },
  };
}

export function normalizeOperatorPlan(plan) {
  const source = normalizeRecord(plan);
  const intent = normalizeString(source.intent);
  if (!intent || !EXECUTABLE_OPERATOR_PLAN_INTENTS.has(intent)) {
    throw new Error(`unsupported operator intent: ${intent || "unknown"}`);
  }

  const steps = Array.isArray(source.steps)
    ? source.steps.map((step, index) => validatePlanStep(step, index))
    : [];
  if (steps.length === 0) {
    throw new Error("operator plan has no executable steps");
  }

  return {
    intent,
    summary: normalizeString(source.summary) || "operator plan",
    reply: normalizeString(source.reply) || null,
    warnings: normalizeTextList(source.warnings),
    limitations: normalizeTextList(source.limitations),
    assumptions: normalizeTextList(source.assumptions),
    derived: collectPlanDerivedFields(steps, source.derived),
    steps,
  };
}

export function normalizeOperatorBrainPlanResult(brainResult, requestText) {
  const source = normalizeRecord(brainResult?.plan);
  const rawIntent = normalizeString(source.intent);
  const steps = Array.isArray(source.steps)
    ? source.steps.map((step, index) => validatePlanStep(step, index))
    : [];
  const intent = steps.length > 0
    ? (rawIntent && rawIntent !== "advice_only" && rawIntent !== "unsupported" ? rawIntent : "platform_mutation")
    : (rawIntent || "advice_only");
  const derived = collectPlanDerivedFields(steps, source.derived);

  if (steps.length > 0 && shouldPreferAdviceOnly(requestText, intent)) {
    return buildPlanResponse({
      intent: "advice_only",
      reply: normalizeString(source.reply)
        || "这条消息更像在问系统该怎么工作，我先给解释，不直接生成可执行计划。",
      summary: normalizeString(source.summary) || "operator 建议",
      warnings: source.warnings,
      limitations: uniqueStrings([
        ...normalizeTextList(source.limitations),
        "如果你要我直接改图或改配置，请用明确动作表达，例如“连接 A 到 B”或“给 X 配置 Y”。",
      ]),
      assumptions: source.assumptions,
      derived: {
        requestText: normalizeText(requestText),
        ...derived,
        plannerSource: brainResult?.source || "operator_brain_llm",
        plannerModel: normalizeString(brainResult?.plannerModel) || null,
        adviceDemotion: "question_request_without_explicit_action",
      },
      steps: [],
    });
  }

  return buildPlanResponse({
    intent,
    reply: normalizeString(source.reply)
      || (steps.length > 0 ? "我整理出了一份可执行的 operator 计划。" : "我先给你一个不越权的建议。"),
    summary: normalizeString(source.summary)
      || (steps.length > 0 ? "生成 operator 计划" : "operator 建议"),
    warnings: source.warnings,
    limitations: source.limitations,
    assumptions: source.assumptions,
    derived: {
      requestText: normalizeText(requestText),
      ...derived,
      plannerSource: brainResult?.source || "operator_brain_llm",
      plannerModel: normalizeString(brainResult?.plannerModel) || null,
    },
    steps,
  });
}
