import { normalizeRecord, normalizeString } from "./core/normalize.js";

const DEFAULT_PLANNER_TIMEOUT_MS = 45000;

function buildChatCompletionsUrl(baseUrl) {
  const normalized = normalizeString(baseUrl);
  if (!normalized) return null;
  return new URL("chat/completions", normalized.endsWith("/") ? normalized : `${normalized}/`).toString();
}

function extractAssistantText(payload) {
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

export async function callOpenAICompatiblePlanner({
  model,
  baseUrl,
  apiKey,
  systemPrompt,
  userPrompt,
  timeoutMs = DEFAULT_PLANNER_TIMEOUT_MS,
  temperature = 0.1,
  maxTokens = 1800,
}) {
  const endpoint = buildChatCompletionsUrl(baseUrl);
  if (!endpoint) throw new Error("planner missing provider baseUrl");
  if (!normalizeString(apiKey)) throw new Error("planner missing provider apiKey");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        temperature,
        max_tokens: maxTokens,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
      }),
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload?.error?.message || payload?.message || `planner http ${response.status}`);
    }
    const content = extractAssistantText(payload);
    const jsonText = extractJsonText(content);
    if (!jsonText) throw new Error("planner returned empty content");
    return JSON.parse(jsonText);
  } finally {
    clearTimeout(timeout);
  }
}
