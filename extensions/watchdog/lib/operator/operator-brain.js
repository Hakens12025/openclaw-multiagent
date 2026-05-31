import { detectCycles } from "../agent/agent-graph.js";
import { AGENT_ROLE } from "../agent/agent-metadata.js";
import { resolveModelRef, resolveOperatorBrainModel } from "../brain-model-resolver.js";
import {
  listModelRegistry,
  listSkillRegistry,
  loadOpenClawConfig,
  readAgentDefaultsRegistry,
} from "../capability/capability-registry.js";
import { callOpenAICompatiblePlanner } from "../llm-planner.js";
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

function summarizeAgentForBrain(agent) {
  return {
    id: normalizeString(agent?.id) || "unknown",
    name: normalizeString(agent?.name) || normalizeString(agent?.id) || "unknown",
    role: normalizeString(agent?.role) || null,
    model: normalizeString(agent?.model) || null,
    description: compactText(agent?.description, 140),
    skills: Array.isArray(agent?.effectiveSkills) ? agent.effectiveSkills.slice(0, 12) : [],
    gateway: agent?.gateway === true,
    protected: agent?.protected === true,
    ingressSource: normalizeString(agent?.ingressSource) || null,
    specialized: agent?.specialized === true,
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

function buildLoopPlanningHints({ loops, loopSessions }) {
  const registeredLoops = Array.isArray(loops) ? loops : [];
  const sessions = Array.isArray(loopSessions) ? loopSessions : [];
  const findByStatus = (status) => sessions.find((s) => (normalizeString(s?.runtimeStatus || s?.status)?.toLowerCase()) === status) || null;
  const activeSession = sessions.find((s) => s?.active === true) || null;
  const brokenSession = findByStatus("broken");
  const interruptedSession = findByStatus("interrupted");
  const repairableLoops = registeredLoops.filter((loop) => Array.isArray(loop?.missingEdges) && loop.missingEdges.length > 0);
  const singleLoop = registeredLoops.length === 1 ? registeredLoops[0] : null;

  return {
    activeLoopId: normalizeString(activeSession?.loopId) || null,
    activeLoopStage: normalizeString(activeSession?.currentStage) || null,
    repairCandidateLoopId: normalizeString(brokenSession?.loopId || (repairableLoops.length === 1 ? repairableLoops[0]?.id : null) || singleLoop?.id) || null,
    resumeCandidateLoopId: normalizeString(interruptedSession?.loopId || brokenSession?.loopId || singleLoop?.id) || null,
    resumeCandidateStage: normalizeString(interruptedSession?.currentStage || brokenSession?.currentStage) || null,
    registeredLoopIds: registeredLoops.map((loop) => normalizeString(loop?.id)).filter(Boolean).slice(0, 8),
  };
}

export function buildOperatorPlanningFocus({ agents = [], loops = [], loopSessions = [], conversation = [], currentPlan = null } = {}) {
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
      loopId: normalizeString(currentPlan?.derived?.loopId) || null,
    },
    gatewayAgents: uniqueStrings(agentList.filter((a) => a?.gateway === true).map((a) => normalizeString(a?.id)).filter(Boolean)).slice(0, 8),
    loopHints: buildLoopPlanningHints({ loops, loopSessions }),
  };
}

function buildBrainContext({ requestText, modelRef, agentDefaults, agents, skills, models, surfaces, graph, loops, loopSessions, knowledge, history, currentPlan, planningFocus, testReports, harnessRuns, automationRuntimes }) {
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
        loops: (Array.isArray(loops) ? loops : []).map((l) => ({ id: normalizeString(l?.id) || "unknown", entryAgentId: normalizeString(l?.entryAgentId) || null, nodes: Array.isArray(l?.nodes) ? l.nodes : [], active: l?.active === true })),
        loopSessions: (Array.isArray(loopSessions) ? loopSessions : []).map((s) => ({ id: normalizeString(s?.id) || "unknown", loopId: normalizeString(s?.loopId) || null, currentStage: normalizeString(s?.currentStage) || null, round: Number.isFinite(s?.round) ? s.round : null, runtimeStatus: normalizeString(s?.runtimeStatus) || normalizeString(s?.status) || null })),
      },
      automationRuntimes: (Array.isArray(automationRuntimes) ? automationRuntimes : []).map((rt) => ({ automationId: rt?.automationId || null, status: rt?.status || null, currentRound: rt?.currentRound || 0, lastScore: rt?.lastScore ?? null, bestScore: rt?.bestScore ?? null, lastReviewerResult: rt?.lastReviewerResult || null, lastAutomationDecision: rt?.lastAutomationDecision || null })),
      recentHarnessRuns: (Array.isArray(harnessRuns) ? harnessRuns : []).slice(0, 5).map((run) => ({ id: run?.id || null, automationId: run?.automationId || null, round: run?.round || null, status: run?.status || null, score: run?.score ?? null, verdict: run?.gateSummary?.verdict || run?.reviewerResult?.verdict || null, failedModules: run?.gateSummary?.failed || 0 })),
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
    "executableSurfaces include apply (write) and verify (test_runs.start / test.inject) surfaces. When you mutate the platform, you may append a verify step to confirm the change (inspect -> apply -> verify governance loop).",
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
  const { agents, graph, loops, loopSessions, harnessRuns, testReports, automationRuntimes } = coreData;

  const modelRef = resolveOperatorBrainModel(config);
  if (!modelRef.providerId || !modelRef.modelId) throw new Error("operator brain could not resolve a planner model");
  if (!modelRef.baseUrl || !modelRef.apiKey) throw new Error(`operator brain provider is not ready: ${modelRef.providerId}`);

  const surfaces = listOperatorExecutableCliSystemSurfaces({ includeTemplates: true });
  const [knowledge, planningFocus] = await Promise.all([
    buildOperatorKnowledgeContext({ requestText, graph, loops, loopSessions, skills, surfaces }),
    Promise.resolve(buildOperatorPlanningFocus({ agents, loops, loopSessions, conversation: history, currentPlan })),
  ]);

  const context = buildBrainContext({ requestText, modelRef: modelRef.fullRef, agentDefaults, agents, skills, models, surfaces, graph, loops, loopSessions, knowledge, history, currentPlan, planningFocus, testReports, harnessRuns, automationRuntimes });

  logger?.info?.(`[watchdog] operator-brain planning with ${modelRef.fullRef}`);
  const rawPlan = await callOpenAICompatiblePlanner({
    model: modelRef.modelId,
    baseUrl: modelRef.baseUrl,
    apiKey: modelRef.apiKey,
    systemPrompt: buildOperatorBrainSystemPrompt(),
    userPrompt: ["Plan or answer based on this live platform context.", "Use advice_only for low-confidence execution.", JSON.stringify(context, null, 2)].join("\n\n"),
  });

  return { ok: true, source: "operator_brain_llm", plannerModel: modelRef.fullRef, context, plan: normalizeRecord(rawPlan) };
}
