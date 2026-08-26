import { normalizeRecord, normalizeString } from "../core/normalize.js";

const DEFAULT_PLANNER_TIMEOUT_MS = 45000;

// undici's default headersTimeout/bodyTimeout is 300s. A loaded REASONING model (e.g. glm-5.1) can
// exceed that to first byte → UND_ERR_SOCKET / UND_ERR_HEADERS_TIMEOUT ("fetch failed") even though
// our AbortController would still be ticking. We can't import undici (0 deps), so derive a long-timeout
// Agent from the global dispatcher's own constructor. Wall-clock stays governed by the AbortController;
// when the symbol is absent (non-undici runtime) this returns null and the fetch is unchanged.
let cachedPlannerDispatcher;
function resolvePlannerDispatcher() {
  if (cachedPlannerDispatcher !== undefined) return cachedPlannerDispatcher;
  cachedPlannerDispatcher = null;
  try {
    const sym = Object.getOwnPropertySymbols(globalThis).find((s) => s.description === "undici.globalDispatcher.1");
    const AgentCtor = sym ? globalThis[sym]?.constructor : null;
    if (typeof AgentCtor === "function") {
      cachedPlannerDispatcher = new AgentCtor({ headersTimeout: 0, bodyTimeout: 0, keepAliveTimeout: 600000 });
    }
  } catch {
    cachedPlannerDispatcher = null;
  }
  return cachedPlannerDispatcher;
}

export function buildChatCompletionsUrl(baseUrl) {
  const normalized = normalizeString(baseUrl);
  if (!normalized) return null;
  return new URL("chat/completions", normalized.endsWith("/") ? normalized : `${normalized}/`).toString();
}

export function extractAssistantText(payload) {
  const firstChoice = Array.isArray(payload?.choices) ? payload.choices[0] : null;
  const message = normalizeRecord(firstChoice?.message);
  const content = message.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === "string") return item;
        if (item && typeof item === "object") {
          if (typeof item.text === "string") return item.text;
          if (typeof item.content === "string") return item.content;
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function extractJsonText(text) {
  const normalized = String(text || "").trim();
  if (!normalized) return "";
  const fenceMatch = normalized.match(/```(?:json)?\s*([\s\S]+?)\s*```/i);
  if (fenceMatch?.[1]) return fenceMatch[1].trim();
  const firstBrace = normalized.indexOf("{");
  const lastBrace = normalized.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    return normalized.slice(firstBrace, lastBrace + 1);
  }
  return normalized;
}

// Defensive repair for truncated / trailing-comma JSON (glm-style streams cut off mid-output).
// String-aware single pass: drop trailing commas before closers, close an unterminated string,
// strip a dangling colon/comma at the end, then append matching closers for still-open containers.
// Best-effort — salvages the common "cut off at the end" case; unsalvageable input still throws below.
export function repairTruncatedJsonText(text) {
  const raw = String(text || "").trim();
  if (!raw) return raw;
  const stack = [];
  let inString = false;
  let escaped = false;
  let out = "";
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; out += ch; continue; }
    if (ch === ",") {
      let j = i + 1;
      while (j < raw.length && /\s/.test(raw[j])) j += 1;
      if (j >= raw.length || raw[j] === "}" || raw[j] === "]") continue; // drop trailing comma
      out += ch;
      continue;
    }
    if (ch === "{" || ch === "[") stack.push(ch);
    else if (ch === "}" || ch === "]") stack.pop();
    out += ch;
  }
  if (inString) out += '"';
  out = out.replace(/[,:]\s*$/, "");
  for (let i = stack.length - 1; i >= 0; i -= 1) out += stack[i] === "{" ? "}" : "]";
  return out;
}

// Parse planner JSON; on failure attempt a structural repair, then on second failure throw a
// CODED error so the caller can distinguish "model returned unparseable plan" (→ invalid-plan
// fallback) from "brain unavailable" (→ network/provider fallback). Conflating them mislabels bugs.
export function parsePlannerJson(jsonText) {
  try {
    return JSON.parse(jsonText);
  } catch {
    try {
      return JSON.parse(repairTruncatedJsonText(jsonText));
    } catch (err) {
      const error = new Error(`planner JSON parse failed after repair: ${err.message}`);
      error.code = "PLANNER_JSON_PARSE_FAILED";
      throw error;
    }
  }
}

export async function callOpenAICompatiblePlanner({
  model,
  baseUrl,
  apiKey,
  systemPrompt,
  userPrompt,
  timeoutMs = DEFAULT_PLANNER_TIMEOUT_MS,
  // FIX(kimi-temp): default to OMIT temperature (null), not 0.1. The Kimi coding endpoint (and some
  // providers) reject any temperature != 1; embedded agents already work because they omit it. Omitting
  // lets each provider apply its own default and is provider-agnostic; a caller may still pass a finite
  // value explicitly. Verified live: Kimi accepts requests with no temperature.
  temperature = null,
  maxTokens = 4096,
}) {
  const endpoint = buildChatCompletionsUrl(baseUrl);
  if (!endpoint) throw new Error("planner missing provider baseUrl");
  if (!normalizeString(apiKey)) throw new Error("planner missing provider apiKey");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const dispatcher = resolvePlannerDispatcher();
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        // FIX(kimi-temp): only include temperature when a caller passes a finite value; omit otherwise
        // so temperature-restricted providers (Kimi coding: only temperature==1) accept the request.
        ...(Number.isFinite(temperature) ? { temperature } : {}),
        max_tokens: maxTokens,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
      }),
      signal: controller.signal,
      ...(dispatcher ? { dispatcher } : {}),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload?.error?.message || payload?.message || `planner http ${response.status}`);
    }
    const content = extractAssistantText(payload);
    const jsonText = extractJsonText(content);
    if (!jsonText) throw new Error("planner returned empty content");
    return parsePlannerJson(jsonText);
  } finally {
    clearTimeout(timeout);
  }
}
