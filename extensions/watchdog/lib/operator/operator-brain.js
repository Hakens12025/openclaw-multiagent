import { detectCycles } from "../agent/agent-graph.js";
import { AGENT_ROLE } from "../agent/agent-metadata.js";
import { resolveModelRef, resolveBrainModelChain } from "../llm/brain-model-resolver.js";
import { broadcast } from "../transport/sse.js";
import {
  listModelRegistry,
  listSkillRegistry,
  loadOpenClawConfig,
  readAgentDefaultsRegistry,
} from "../management/capability-registry.js";
import { callOpenAICompatiblePlanner } from "../llm/llm-planner.js";
import { EXECUTABLE_OPERATOR_PLAN_INTENTS } from "./operator-plan.js";
import { normalizeRecord, normalizeString, uniqueStrings, compactText } from "../core/normalize.js";
import { buildOperatorKnowledgeContext } from "./operator-knowledge.js";
import { loadSnapshotCoreData } from "./operator-snapshot.js";
import { listOperatorExecutableCliSystemSurfaces } from "./operator-surface-policy.js";

const OPERATOR_BRAIN_MAX_SKILLS = 32;
const OPERATOR_BRAIN_MAX_MODELS = 24;
const OPERATOR_BRAIN_MAX_HISTORY = 8;

function normalizeText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function summarizeSurfaceForBrain(surface) {
  const template = normalizeRecord(surface?.changeSetTemplate);
  return {
    id: normalizeString(surface?.id) || "unknown",
    summary: compactText(surface?.summary, 120),
    payloadTemplate: normalizeRecord(template.payload),
    inputFields: (Array.isArray(template.inputFields) ? template.inputFields : []).map((field) => ({
      key: normalizeString(field?.key) || "unknown",
      required: field?.required === true,
      type: normalizeString(field?.type) || null,
      description: compactText(field?.description, 120),
      optionsSource: normalizeString(field?.optionsSource) || null,
      canonicalPath: normalizeString(field?.canonicalPath) || null,
    })),
  };
}

// Slim per-agent summary (token 少量): just id + role + model. The in/out edges + role-summary live
// in the Agent Map fragment (operator-knowledge.js buildAgentMapFragment); the skill catalog is in
// context.skills. The old description(140)+effectiveSkills(12)+4 flags dump was the heavy reading cost.
function summarizeAgentForBrain(agent) {
  return {
    id: normalizeString(agent?.id) || "unknown",
    role: normalizeString(agent?.role) || null,
    model: normalizeString(agent?.model) || null,
  };
}

function summarizeSkillForBrain(skill) {
  return {
    id: normalizeString(skill?.id) || "unknown",
    name: normalizeString(skill?.name) || normalizeString(skill?.id) || "unknown",
    description: compactText(skill?.description, 120),
    defaultEnabled: skill?.defaultEnabled === true,
  };
}

function summarizeModelForBrain(model) {
  const provider = normalizeString(model?.provider);
  const modelId = normalizeString(model?.id);
  return {
    ref: provider && modelId ? `${provider}/${modelId}` : modelId || "unknown",
    label: normalizeString(model?.name) || modelId || "unknown",
    contextWindow: Number.isFinite(model?.contextWindow) ? model.contextWindow : null,
  };
}

function summarizeConversationForBrain(history) {
  return (Array.isArray(history) ? history : [])
    .map((turn) => {
      const role = normalizeString(turn?.role)?.toLowerCase();
      const text = compactText(turn?.text, 220);
      if ((role !== "user" && role !== "assistant") || !text) return null;
      return { role, text, ts: Number.isFinite(turn?.ts) ? turn.ts : null };
    })
    .filter(Boolean)
    .slice(-OPERATOR_BRAIN_MAX_HISTORY);
}

function summarizeCurrentPlanForBrain(plan) {
  const source = normalizeRecord(plan, null);
  if (!source) return null;
  const intent = normalizeString(source.intent);
  const summary = compactText(source.summary, 140);
  const derived = normalizeRecord(source.derived);
  const steps = Array.isArray(source.steps)
    ? source.steps
        .map((step) => {
          const surfaceId = normalizeString(step?.surfaceId);
          if (!surfaceId) return null;
          return { surfaceId, title: compactText(step?.title, 90), summary: compactText(step?.summary, 120), payload: normalizeRecord(step?.payload) };
        })
        .filter(Boolean).slice(0, 8)
    : [];
  if (!intent && !summary && steps.length === 0 && Object.keys(derived).length === 0) return null;
  return { intent: intent || null, summary, derived, steps };
}

function collectReferencedAgentIds({ currentPlan, conversation, knownAgentIds }) {
  const known = Array.isArray(knownAgentIds) ? knownAgentIds : [];
  const refs = [];
  const derived = normalizeRecord(currentPlan?.derived);
  refs.push(
    normalizeString(derived.agentId),
    normalizeString(derived.fromAgentId),
    normalizeString(derived.toAgentId),
    ...(Array.isArray(derived.agentIds) ? derived.agentIds.map((item) => normalizeString(item)) : []),
  );
  for (const turn of Array.isArray(conversation) ? conversation : []) {
    const text = normalizeText(turn?.text).toLowerCase();
    if (!text) continue;
    for (const agentId of known) {
      if (text.includes(agentId.toLowerCase())) refs.push(agentId);
    }
  }
  return uniqueStrings(refs.filter(Boolean)).slice(-8);
}

export function buildOperatorPlanningFocus({ agents = [], conversation = [], currentPlan = null } = {}) {
  const agentList = Array.isArray(agents) ? agents : [];
  const webuiGatewayAgent = agentList.find((agent) => {
    if (agent?.gateway !== true) return false;
    const ingressSource = normalizeString(agent?.ingressSource)?.toLowerCase();
    return !ingressSource || ingressSource === "webui";
  }) || null;
  const knownAgentIds = agentList.map((a) => normalizeString(a?.id)).filter(Boolean);

  return {
    defaults: {
      webuiGatewayAgentId: normalizeString(webuiGatewayAgent?.id) || null,
      preferWebuiGatewayLinksForReporting: webuiGatewayAgent != null,
      generatedAgentIdStyle: "kebab-case",
      supportedRoles: Object.values(AGENT_ROLE),
    },
    recentReferents: {
      agentIds: collectReferencedAgentIds({ currentPlan, conversation, knownAgentIds }),
    },
    gatewayAgents: uniqueStrings(agentList.filter((a) => a?.gateway === true).map((a) => normalizeString(a?.id)).filter(Boolean)).slice(0, 8),
  };
}

function buildBrainContext({ requestText, modelRef, agentDefaults, agents, skills, models, surfaces, graph, knowledge, history, currentPlan, planningFocus, testReports, automationRuntimes }) {
  const edges = Array.isArray(graph?.edges) ? graph.edges : [];
  return {
    request: requestText,
    plannerModel: modelRef,
    supportedRoles: Object.values(AGENT_ROLE),
    runtime: {
      defaultAgentModel: resolveModelRef(agentDefaults?.configuredDefaultModel || agentDefaults?.effectiveDefaultModel) || resolveModelRef(agentDefaults?.model) || null,
      configuredDefaultSkills: Array.isArray(agentDefaults?.configuredDefaultSkills) ? agentDefaults.configuredDefaultSkills : [],
      effectivePlatformDefaultSkills: Array.isArray(agentDefaults?.effectivePlatformDefaultSkills) ? agentDefaults.effectivePlatformDefaultSkills : [],
      agentCount: agents.length,
      skillCount: skills.length,
      modelCount: models.length,
      graph: {
        edgeCount: edges.length,
        cycles: detectCycles(graph),
        edges: edges.map((e) => ({ from: normalizeString(e?.from) || "unknown", to: normalizeString(e?.to) || "unknown", label: normalizeString(e?.label) || null })),
      },
      automationRuntimes: (Array.isArray(automationRuntimes) ? automationRuntimes : []).map((rt) => ({ automationId: rt?.automationId || null, status: rt?.status || null, currentRound: rt?.currentRound || 0, lastScore: rt?.lastScore ?? null, bestScore: rt?.bestScore ?? null, lastAutomationDecision: rt?.lastAutomationDecision || null })),
    },
    agents: agents.map(summarizeAgentForBrain),
    skills: skills.slice(0, OPERATOR_BRAIN_MAX_SKILLS).map(summarizeSkillForBrain),
    models: models.slice(0, OPERATOR_BRAIN_MAX_MODELS).map(summarizeModelForBrain),
    executableSurfaces: surfaces.map(summarizeSurfaceForBrain),
    conversation: { recentTurns: summarizeConversationForBrain(history), currentPlan: summarizeCurrentPlanForBrain(currentPlan) },
    planningFocus: normalizeRecord(planningFocus),
    knowledge: normalizeRecord(knowledge),
    testReports: Array.isArray(testReports) ? testReports : [],
  };
}

function buildOperatorBrainSystemPrompt() {
  return [
    "You are Runtime Operator Brain for OpenClaw.",
    "You are the control-plane steward for inspect, apply, and verify.",
    "Understand the user's request, then return a structured plan using provided cli-system surfaces or answer in advice_only mode with zero steps.",
    "Use context.agent/surface/schema ids exactly as provided.",
    "Plan only with executableSurfaces. For unsupported requests, use intent=advice_only with steps=[].",
    "OpenClaw is a GENERAL multi-agent machine. A domain's missing capability (computation, backtesting, data parsing, a domain method) is something you BUILD, NOT a reason to refuse: grant the agent tools via agents.tools (e.g. bash to run calculations), author the domain method as a skill via skills.create, set role via agents.role, then wire the structure with graph.edge.add. An ITERATIVE structure is just edges closed into a cycle (a -> b -> c -> a); the platform detects and highlights the cycle by itself — there is no separate loop object to register. Wiring the edges makes the structure active; you do NOT start it. Reserve advice_only for requests that genuinely cannot be expressed with ANY provided surface — never merely because a domain needs a specialized agent. Default to BUILDING a runnable structure (the human refines it later) over giving advice.",
    "You DESIGN the control plane; you do NOT run the user's concrete one-off task. A wired structure sitting idle (its authorization edges exist, nothing running) is the CORRECT end state of a build plan. End a build plan at the structure (agents.create / graph.edge.add — close the edges into a cycle when the work is iterative / graph.group.compose for a parallel group) + agent content (agents.role, agents.tools e.g. bash, agents.description, agents.constraints, domain method authored as a skill via skills.create then attached via agents.skills) + an inspect.structure_preview. Do NOT append any step that runs the user's concrete task: the one-off task is dispatched to the built structure SEPARATELY downstream by the user/ingress — it arrives in the entry agent's inbox and the conveyor advances it hop by hop along the edges; a cyclic structure simply keeps going around.",
    "executableSurfaces include apply (write) and verify (test_runs.start / test.inject) surfaces. When you mutate the platform, you may append a verify step to confirm the change (inspect -> apply -> verify governance loop).",
    "VISUALIZATION / CHART requests (plot some data as a line/bar/pie chart) are NOT yours to build directly: do NOT emit apply.chart_create yourself. Instead summon the visualization master — a specialized meta-agent — with EXACTLY ONE step { surfaceId: \"meta.delegate\", title: \"...\", payload: { targetActor: \"viz-master\", request: \"<the chart intent + the actual data points to plot>\" } } and intent=platform_mutation. viz-master picks the chart type, derives the spec, and writes the chart; you only delegate. meta.delegate is a special non-surface step (it is NOT one of the executableSurfaces ids).",
    "Graph edges are directional. Proposed graph changes must appear as graph surface steps.",
    "Use conversation and planningFocus to resolve clear follow-up references.",
    "Use knowledge fragments as platform-grounded local evidence.",
    "Return only the concise JSON object matching this schema.",
    "JSON schema:",
    JSON.stringify({
      intent: "create_agent | connect_agents | disconnect_agents | agent_mutation | graph_mutation | platform_mutation | advice_only",
      summary: "short summary",
      reply: "natural language answer to user",
      warnings: ["optional warning"],
      limitations: ["optional limitation"],
      assumptions: ["optional assumption"],
      derived: { reason: "optional structured notes" },
      steps: [{ surfaceId: "one of executableSurfaces ids", title: "short title", summary: "why this step exists", payload: {} }],
    }, null, 2),
  ].join("\n");
}

// Reliability: minimax-m2.5 intermittently returns a BUILD intent with empty steps[] (it "decided"
// to build but emitted nothing), or malformed JSON. A plan is "degenerate" when it declares an
// executable build intent yet carries zero steps. advice_only/empty and null-intent are NOT
// degenerate (legitimate no-build → no wasteful retry).
export function isDegeneratePlannerPlan(rawPlan) {
  const plan = normalizeRecord(rawPlan);
  const steps = Array.isArray(plan.steps) ? plan.steps : [];
  return EXECUTABLE_OPERATOR_PLAN_INTENTS.has(normalizeString(plan.intent)) && steps.length === 0;
}

// Single retry for a degenerate or unparseable plan — converts the observed "several calls return
// empty steps" flakiness into a recoverable single re-ask. A network/socket error (UND_ERR_SOCKET,
// abort) is rethrown after the first call so the retry NEVER masks a provider/GLM-socket failure;
// only PLANNER_JSON_PARSE_FAILED + degenerate-but-parsed trigger the re-ask.
export async function callPlannerWithSingleRetry(plannerArgs) {
  try {
    const first = await callOpenAICompatiblePlanner(plannerArgs);
    if (!isDegeneratePlannerPlan(first)) return first;
  } catch (error) {
    if (error?.code !== "PLANNER_JSON_PARSE_FAILED") throw error;
  }
  return callOpenAICompatiblePlanner({
    ...plannerArgs,
    userPrompt: `${plannerArgs.userPrompt}\n\nReturn a complete valid JSON plan with non-empty steps; do not declare a build intent with empty steps.`,
  });
}

// Provider resilience (TIER-1, oh-my-pi borrow, 备忘录125): walk an ordered model chain, falling back
// to the NEXT provider ONLY on a provider-class failure (quota / socket / timeout / http error). A
// PLANNER_JSON_PARSE_FAILED is a CONTENT failure (the model answered but unparseably) — that is
// callPlannerWithSingleRetry's job and must NOT trigger a cross-provider fallback, else we'd silently
// re-run the same bad reasoning on a second provider and mislabel the failure class. Empty chain is a
// caller error (resolve readiness first). Emits a structured `provider_fallback` SSE event so the
// dashboard shows which provider actually served. `callPlanner` is injectable for tests. Shared by
// operator-brain and viz-master-brain (both resolve a chain, both walk it here).
export async function callPlannerWithModelFallback({
  modelChain,
  plannerArgs,
  logger = null,
  callPlanner = callPlannerWithSingleRetry,
  onFallback = null,
}) {
  if (!Array.isArray(modelChain) || modelChain.length === 0) {
    throw new Error("planner model chain is empty");
  }
  const fallbacksTried = [];
  for (let i = 0; i < modelChain.length; i += 1) {
    const model = modelChain[i];
    try {
      const plan = await callPlanner({ ...plannerArgs, model: model.modelId, baseUrl: model.baseUrl, apiKey: model.apiKey });
      if (i > 0) {
        const event = { primary: modelChain[0].fullRef, servedBy: model.fullRef, tried: fallbacksTried, ts: Date.now() };
        broadcast("provider_fallback", event);
        if (typeof onFallback === "function") onFallback(event);
      }
      return { plan, servedBy: model, fallbacksTried };
    } catch (error) {
      // Content/plan error → not a provider failure: stop, do not try another provider.
      // Last provider in the chain → exhausted: rethrow.
      if (error?.code === "PLANNER_JSON_PARSE_FAILED" || i === modelChain.length - 1) throw error;
      fallbacksTried.push({ providerRef: model.fullRef, error: normalizeString(error?.message) || "provider error" });
      logger?.warn?.(`[watchdog] brain provider ${model.fullRef} failed (${error?.message}); falling back to ${modelChain[i + 1].fullRef}`);
    }
  }
  throw new Error("planner model chain exhausted");
}

export async function planWithOperatorBrain({ message, history = [], currentPlan = null, logger = null } = {}) {
  const requestText = normalizeText(message);
  if (!requestText) throw new Error("missing operator brain request text");

  const [coreData, config, agentDefaults, skills, models] = await Promise.all([
    loadSnapshotCoreData(),
    loadOpenClawConfig(),
    readAgentDefaultsRegistry(),
    listSkillRegistry(),
    listModelRegistry(),
  ]);
  const { agents, graph, testReports, automationRuntimes } = coreData;

  const modelChain = resolveBrainModelChain(config);
  if (modelChain.length === 0) throw new Error("operator brain could not resolve a ready planner model");
  const modelRef = modelChain[0];

  const surfaces = listOperatorExecutableCliSystemSurfaces({ includeTemplates: true });
  const [knowledge, planningFocus] = await Promise.all([
    buildOperatorKnowledgeContext({ requestText, agents, graph, skills, surfaces }),
    Promise.resolve(buildOperatorPlanningFocus({ agents, conversation: history, currentPlan })),
  ]);

  const context = buildBrainContext({ requestText, modelRef: modelRef.fullRef, agentDefaults, agents, skills, models, surfaces, graph, knowledge, history, currentPlan, planningFocus, testReports, automationRuntimes });

  logger?.info?.(`[watchdog] operator-brain planning with ${modelRef.fullRef}${modelChain.length > 1 ? ` (+${modelChain.length - 1} fallback)` : ""}`);
  const { plan: rawPlan, servedBy } = await callPlannerWithModelFallback({
    modelChain,
    plannerArgs: {
      systemPrompt: buildOperatorBrainSystemPrompt(),
      userPrompt: ["Plan or answer based on this live platform context.", "If the request describes agents, a workflow, an iterative cycle, or a pipeline to build, you MUST emit build steps — agent content (agents.create + agents.role / agents.skills / agents.tools / agents.description) and structure (graph.edge.add, closed into a cycle when the work iterates). That is a SUPPORTED build request: do NOT return advice_only with empty steps for it. Reuse existing agents/skills where they fit. Use advice_only ONLY when no provided surface can express the request.", JSON.stringify(context, null, 2)].join("\n\n"),
      // Build-planning is heavy reasoning over a large live context (not a quick chat) and emits a
      // multi-step plan — the default 45s aborts mid-generation on a loaded provider. Give it room;
      // the dashboard shows a pending state while it plans.
      timeoutMs: 120000,
      // Reasoning models (e.g. glm-5.1) spend tokens on reasoning_content BEFORE emitting the plan
      // in content; 4096 can leave the plan JSON empty/truncated. Budget for reasoning + the plan.
      maxTokens: 8192,
    },
    logger,
  });

  return { ok: true, source: "operator_brain_llm", plannerModel: servedBy.fullRef, context, plan: normalizeRecord(rawPlan) };
}
