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
import { listOperatorExecutableAdminSurfaces } from "./operator-surface-policy.js";

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
  const controllerAgent = agentList.find((a) => normalizeString(a?.id) === "controller") || null;
  const knownAgentIds = agentList.map((a) => normalizeString(a?.id)).filter(Boolean);

  return {
    defaults: {
      controllerAgentId: normalizeString(controllerAgent?.id) || null,
      preferControllerLinksForReporting: controllerAgent != null,
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
    "You are a declarative platform steward, not the executor.",
    "You must understand the user's request, then either produce a safe structured plan using only the provided admin surfaces, or answer in advice_only mode with zero steps.",
    "Hard rules:",
    "1. Never invent admin surfaces, file paths, schema keys, or agent ids.",
    "2. Only use steps whose surfaceId appears in executableSurfaces.",
    "3. If a request cannot be completed by the provided surfaces, set intent=advice_only and steps=[].",
    "4. Directed graph edges are directional. Only listed edges exist.",
    "5. If the request implies front-desk integration or reporting to controller and does not opt out, creating a new agent may include controller <-> newAgent edges.",
    "6. For existing-agent edits in this version, prefer the provided surfaces for name / description / skills / policy changes instead of advice_only when they materially satisfy the request.",
    "7. Changing communication protocols, runtime kernel logic, or code files without a surface is advice_only.",
    "8. Reply concisely and concretely.",
    "9. Treat knowledge.selectedFragments, knowledge.retrievedNotes, and knowledge.notableSkills as platform-grounded rules and local evidence. Follow them over your own generic priors.",
    "10. If retrievedNotes explain why something is unsupported or graph-gated, preserve that distinction in the reply.",
    "11. Use conversation.recentTurns, conversation.currentPlan, and planningFocus.recentReferents to resolve follow-up references like '\u8fd9\u4e2a agent' or '\u5f53\u524d loop' when the target is unambiguous.",
    "12. If planningFocus.loopHints exposes a single clear repair/resume candidate and the user asks to fix, repair, continue, or optimize the current loop/chain, prefer executable structural steps.",
    "13. When creating a new agent without an explicit id, derive a concise kebab-case id from the requested duty, choose a supportedRoles value, and add name/description steps when helpful.",
    "14. If the request asks to make an agent more front-desk-like and policy surfaces are available, consider gateway / ingressSource / skills / description adjustments instead of advice_only.",
    "Return pure JSON only, no markdown fences.",
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

  const surfaces = listOperatorExecutableAdminSurfaces({ includeTemplates: true });
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
    userPrompt: ["Plan or answer based on this live platform context.", "If you are not certain enough to execute, prefer advice_only.", JSON.stringify(context, null, 2)].join("\n\n"),
  });

  return { ok: true, source: "operator_brain_llm", plannerModel: modelRef.fullRef, context, plan: normalizeRecord(rawPlan) };
}
