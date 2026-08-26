import {
  findMissingRequiredCliSystemSurfaceFields,
  normalizeCliSystemSurfacePayload,
} from "../cli-system/cli-surface-registry.js";
import { isOperatorExecutableSurfaceId } from "./operator-surface-policy.js";
import { normalizeOrderedStringArray, normalizeRecord, normalizeString, uniqueStrings } from "../core/normalize.js";
import { listAgentRegistry } from "../management/capability-registry.js";

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
    } else {
      // 非 2 边一律非双向（单边不可能双向；>2 边非双向语义）。
      // 显式置 false，避免从上一轮 derived 继承到的 bidirectional=true 残留。
      nextDerived.bidirectional = false;
    }
  }

  return nextDerived;
}

function validatePlanStep(step, index) {
  const source = normalizeRecord(step);
  const surfaceId = normalizeString(source.surfaceId);
  // meta.delegate — a NON-surface step: operator hands a sub-request to another meta-agent
  // in-process (R2 delegation, e.g. operator → viz-master for a chart). It is NOT a cli-system
  // surface, so it skips surface-payload validation and instead requires { targetActor, request }.
  // The target meta-agent's writes are authorized downstream by the executor's actor-ownership
  // backstop (assertActorOwnsSurface under the target actor) — the fork only exempts the step from
  // surface validation, never from ownership.
  if (surfaceId === "meta.delegate") {
    const targetActor = normalizeString(source.payload?.targetActor);
    const request = normalizeString(source.payload?.request);
    if (!targetActor || !request) {
      throw new Error(`meta.delegate step at index ${index} requires payload.targetActor and payload.request`);
    }
    return {
      surfaceId: "meta.delegate",
      title: normalizeString(source.title) || `delegate to ${targetActor}`,
      summary: normalizeString(source.summary) || null,
      payload: { targetActor, request },
    };
  }
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

// E2 — feasibility pre-flight. A graph/group step that references an agent which neither
// already exists nor is created by an EARLIER step in the same plan would half-apply then throw.
// collectReferencedAgentIds returns the agent ids a step depends on (accepts array or newline/comma
// string forms, since compose surfaces have no input-field alias-normalization for agentsText).
function idsFromField(value) {
  if (Array.isArray(value)) return value.map((v) => normalizeString(v)).filter(Boolean);
  if (typeof value === "string") return value.split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
  return [];
}

function collectReferencedAgentIds(step) {
  const sid = normalizeString(step?.surfaceId);
  const p = normalizeRecord(step?.payload);
  // Only STRUCTURE-CREATING surfaces are checked: a dangling edge/group member half-applies the
  // structure then throws. agents.* mutations + edge.delete are single ops that fail cleanly at the
  // handler (no half-built structure), so they are intentionally out of scope — avoids false rejects.
  if (sid === "graph.edge.add") {
    return [normalizeString(p.from), normalizeString(p.to)].filter(Boolean);
  }
  if (sid === "graph.group.compose") {
    return uniqueStrings([...idsFromField(p.agents), ...idsFromField(p.agentsText), ...idsFromField(p.members)]);
  }
  return [];
}

// collectOperatorPlanInfeasibilities returns (does NOT throw) the list of dangling-agent references —
// each step referencing an agent neither already in the live registry nor created by an EARLIER
// agents.create step in the same plan. Shared by the throwing pre-flight (execute path) and the
// canExecute downgrade (plan-build path), so both judge feasibility by one rule.
export async function collectOperatorPlanInfeasibilities(normalizedPlan) {
  const steps = Array.isArray(normalizedPlan?.steps) ? normalizedPlan.steps : [];
  if (steps.length === 0) return [];
  const known = new Set((await listAgentRegistry()).map((a) => normalizeString(a?.id)).filter(Boolean));
  const failures = [];
  for (let i = 0; i < steps.length; i += 1) {
    const step = steps[i];
    for (const refId of collectReferencedAgentIds(step)) {
      if (!known.has(refId)) failures.push({ stepIndex: i, surfaceId: normalizeString(step?.surfaceId), missingAgentId: refId });
    }
    if (normalizeString(step?.surfaceId) === "agents.create") {
      const createdId = normalizeString(step?.payload?.id);
      if (createdId) known.add(createdId);
    }
  }
  return failures;
}

// Throws OPERATOR_PLAN_AGENT_INFEASIBLE (with .failures) if any step references an agent not known
// by that point. Known = live agent registry + ids created by earlier agents.create steps in order.
export async function assertOperatorPlanAgentFeasibility(normalizedPlan) {
  const failures = await collectOperatorPlanInfeasibilities(normalizedPlan);
  if (failures.length > 0) {
    const error = new Error(`operator plan references unknown agent(s): ${[...new Set(failures.map((f) => f.missingAgentId))].join(", ")}`);
    error.code = "OPERATOR_PLAN_AGENT_INFEASIBLE";
    error.failures = failures;
    throw error;
  }
}

export function normalizeOperatorBrainPlanResult(brainResult, requestText) {
  const source = normalizeRecord(brainResult?.plan);
  const rawIntent = normalizeString(source.intent);
  // Resilient plan-path normalization: the model occasionally appends ONE hallucinated/unsupported
  // step to an otherwise-valid build plan. The old `.map(validatePlanStep)` threw on the first bad
  // step → the WHOLE plan was discarded → operator returned advice_only with zero steps (a good plan
  // wasted). Drop only the bad step(s), keep the valid ones, and surface a warning. The EXECUTE path
  // (normalizeOperatorPlan) stays strict — it only ever sees these already-validated steps.
  const stepWarnings = [];
  const steps = (Array.isArray(source.steps) ? source.steps : []).reduce((acc, step, index) => {
    try {
      acc.push(validatePlanStep(step, index));
    } catch (err) {
      const sid = normalizeString(normalizeRecord(step).surfaceId) || "未知 surface";
      stepWarnings.push(`已跳过无法执行的步骤 #${index + 1}（${sid}）：${normalizeString(err?.message) || "invalid step"}`);
    }
    return acc;
  }, []);
  // Anti-forgery choke point: provenance (the accept-stage 防伪对照 verdict) is CODE-attested by
  // the dashboard verified-accept path, never LLM-authored. Every brain-planned channel flows
  // through here, so stripping it here closes them all. The verified-accept path calls
  // normalizeOperatorPlan directly and is deliberately NOT stripped.
  for (const step of steps) {
    if (step.payload && typeof step.payload === "object" && "provenance" in step.payload) {
      delete step.payload.provenance;
    }
  }
  const intent = steps.length > 0
    ? (rawIntent && rawIntent !== "advice_only" && rawIntent !== "unsupported" ? rawIntent : "platform_mutation")
    // 0 surviving steps: if we DROPPED bad steps, the model tried to build but nothing was executable →
    // advice_only (the warnings explain what was dropped). Otherwise keep rawIntent (genuine no-build).
    : (stepWarnings.length > 0 ? "advice_only" : (rawIntent || "advice_only"));
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
    warnings: uniqueStrings([...normalizeTextList(source.warnings), ...stepWarnings]),
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
