// viz-master-brain.js — the LLM planner half of the visualization master meta-agent.
// Mirrors operator-brain.js (planWithOperatorBrain) but scoped to the chart family. DRY:
// the planner model resolver (resolveOperatorBrainModel) and the single-retry planner call
// (callPlannerWithSingleRetry) are agent-agnostic and IMPORTED, not duplicated. The executable
// surfaces are narrowed to viz-master ownership by the G2 actor seam
// (filterExecutableSurfacesForActor). viz-master only ever emits ONE apply.chart_create step.

import { resolveOperatorBrainModel } from "../brain-model-resolver.js";
import { loadOpenClawConfig } from "../capability/capability-registry.js";
import { callPlannerWithSingleRetry } from "../operator/operator-brain.js";
import { listOperatorExecutableCliSystemSurfaces } from "../operator/operator-surface-policy.js";
import { filterExecutableSurfacesForActor, resolveSurfaceFamily } from "../cli-system/meta-agent-surface-ownership.js";
import { listCharts } from "../control-plane/chart-registry.js";
import { normalizeRecord, normalizeString, compactText } from "../core/normalize.js";
import { buildVizMasterKnowledgeContext } from "./viz-master-knowledge.js";

const VIZ_BRAIN_MAX_HISTORY = 8;

function normalizeText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

// Same slim per-surface summary shape the operator brain feeds its planner (id + summary +
// payload template + input fields), so the model can fill apply.chart_create.spec correctly.
function summarizeSurfaceForBrain(surface) {
  const template = normalizeRecord(surface?.changeSetTemplate);
  return {
    id: normalizeString(surface?.id) || "unknown",
    summary: compactText(surface?.summary, 160),
    payloadTemplate: normalizeRecord(template.payload),
    inputFields: (Array.isArray(template.inputFields) ? template.inputFields : []).map((field) => ({
      key: normalizeString(field?.key) || "unknown",
      required: field?.required === true,
      type: normalizeString(field?.type) || null,
      description: compactText(field?.description, 160),
    })),
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
    .slice(-VIZ_BRAIN_MAX_HISTORY);
}

function summarizeCurrentPlanForBrain(plan) {
  const source = normalizeRecord(plan, null);
  if (!source) return null;
  const intent = normalizeString(source.intent);
  const summary = compactText(source.summary, 140);
  const steps = Array.isArray(source.steps)
    ? source.steps
        .map((step) => {
          const surfaceId = normalizeString(step?.surfaceId);
          if (!surfaceId) return null;
          return { surfaceId, title: compactText(step?.title, 90), payload: normalizeRecord(step?.payload) };
        })
        .filter(Boolean).slice(0, 4)
    : [];
  if (!intent && !summary && steps.length === 0) return null;
  return { intent: intent || null, summary, steps };
}

function summarizeChartForBrain(chart) {
  return {
    id: normalizeString(chart?.id) || "unknown",
    type: normalizeString(chart?.spec?.type || chart?.type) || null,
    title: compactText(chart?.spec?.title || chart?.label, 90),
  };
}

function buildVizBrainContext({ requestText, modelRef, charts, surfaces, knowledge, history, currentPlan }) {
  return {
    request: requestText,
    plannerModel: modelRef,
    runtime: {
      chartCount: charts.length,
      surfaceCount: surfaces.length,
    },
    existingCharts: charts.map(summarizeChartForBrain),
    executableSurfaces: surfaces.map(summarizeSurfaceForBrain),
    conversation: { recentTurns: summarizeConversationForBrain(history), currentPlan: summarizeCurrentPlanForBrain(currentPlan) },
    knowledge: normalizeRecord(knowledge),
  };
}

export function buildVizMasterBrainSystemPrompt() {
  return [
    "You are the Visualization Master for OpenClaw — a specialized meta-agent.",
    "You OWN the chart family and only the chart family: charts.json is a NON-truth control-plane store (sibling of knowledge-bases.json) and you are its sole writer.",
    "Turn a data + intent request into EXACTLY ONE declarative chart spec and ONE apply.chart_create step carrying that spec.",
    "You never draw SVG and never wire styling — the platform's hand-rolled SVG renderer takes over after apply.chart_create. One plan builds exactly one chart; multi-chart requests must be split into separate requests.",
    "NEVER touch the agent / graph / knowledge families — building agents, editing the graph, running loops, or editing knowledge bases is the operator's domain. For such requests, return intent=advice_only with steps=[] and tell the user this belongs to the operator.",
    "NEVER emit a verify step — apply.chart_create has no verification capability, so a chart build ends at the single apply.chart_create step.",
    "The chart spec contract (validateChartSpec): id (required kebab-case), type (required line|bar|pie), series (required non-empty array of { name, points:[{x:number|string, y:number}] }); title/label/axes/render optional; same id overwrites (upsert). A malformed spec is rejected by the platform — follow the schema strictly.",
    "Plan ONLY with the provided executableSurfaces (chart family). Use context.knowledge fragments as platform-grounded local evidence. Use existingCharts to upsert-by-id instead of duplicating.",
    "Return only the concise JSON object matching this schema.",
    "JSON schema:",
    JSON.stringify({
      intent: "platform_mutation | advice_only",
      summary: "short summary",
      reply: "natural language answer to user",
      warnings: ["optional warning"],
      limitations: ["optional limitation"],
      assumptions: ["optional assumption"],
      derived: { reason: "optional structured notes" },
      steps: [{ surfaceId: "apply.chart_create", title: "short title", summary: "why this step exists", payload: { spec: {} } }],
    }, null, 2),
  ].join("\n");
}

export async function planWithVizMasterBrain({ message, history = [], currentPlan = null, logger = null } = {}) {
  const requestText = normalizeText(message);
  if (!requestText) throw new Error("missing viz-master brain request text");

  const [config, charts] = await Promise.all([
    loadOpenClawConfig(),
    listCharts(),
  ]);

  const modelRef = resolveOperatorBrainModel(config);
  if (!modelRef.providerId || !modelRef.modelId) throw new Error("viz-master brain could not resolve a planner model");
  if (!modelRef.baseUrl || !modelRef.apiKey) throw new Error(`viz-master brain provider is not ready: ${modelRef.providerId}`);

  // G2 actor seam: narrow the operator-executable surfaces to the chart family viz-master owns.
  // viz-master's prompt forbids verify steps; drop the shared test_run family here at the consumer
  // (the ownership backstop still legitimately permits it — see the pinning test) so the brain is
  // never even offered a verify surface to (mis)emit.
  const surfaces = filterExecutableSurfacesForActor(
    "viz-master",
    listOperatorExecutableCliSystemSurfaces({ includeTemplates: true }),
  ).filter((s) => resolveSurfaceFamily(s.id) !== "test_run");
  const knowledge = await buildVizMasterKnowledgeContext({ requestText, charts, surfaces });

  const context = buildVizBrainContext({ requestText, modelRef: modelRef.fullRef, charts, surfaces, knowledge, history, currentPlan });

  logger?.info?.(`[watchdog] viz-master-brain planning with ${modelRef.fullRef}`);
  const rawPlan = await callPlannerWithSingleRetry({
    model: modelRef.modelId,
    baseUrl: modelRef.baseUrl,
    apiKey: modelRef.apiKey,
    systemPrompt: buildVizMasterBrainSystemPrompt(),
    userPrompt: [
      "Plan a chart based on this live chart-plane context.",
      "If the request describes data to visualize as a line/bar/pie chart, you MUST emit EXACTLY ONE apply.chart_create step with payload.spec — that is a supported request, do NOT return advice_only with empty steps for it. Never emit a verify step. Use advice_only ONLY for non-chart requests (those belong to the operator) or requests beyond the line/bar/pie flat-point-set ceiling.",
      JSON.stringify(context, null, 2),
    ].join("\n\n"),
    timeoutMs: 120000,
    maxTokens: 8192,
  });

  return { ok: true, source: "viz_master_brain_llm", plannerModel: modelRef.fullRef, context, plan: normalizeRecord(rawPlan) };
}
