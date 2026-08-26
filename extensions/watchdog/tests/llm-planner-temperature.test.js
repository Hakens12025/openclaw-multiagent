import test from "node:test";
import assert from "node:assert/strict";

import { callOpenAICompatiblePlanner } from "../lib/llm/llm-planner.js";

// FIX(kimi-temp): the Kimi coding endpoint (and some providers) reject any temperature != 1;
// embedded agents work because they omit temperature. The meta-agent brain planner must do the
// same: omit temperature by default (let the provider default apply), and only send an explicit
// one when a caller passes a finite value. Verified live: Kimi accepts requests with no temperature.
test("callOpenAICompatiblePlanner omits temperature by default; sends it only when finite", async () => {
  const bodies = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (_url, opts) => {
    bodies.push(JSON.parse(opts.body));
    return { ok: true, json: async () => ({ choices: [{ message: { content: '{"intent":"advice_only","steps":[]}' } }] }) };
  };
  try {
    // default (no temperature passed) -> body must NOT contain a temperature key (Kimi-safe)
    await callOpenAICompatiblePlanner({ model: "m", baseUrl: "http://x/v1", apiKey: "k", systemPrompt: "s", userPrompt: "u" });
    assert.equal("temperature" in bodies[0], false, "no caller temperature -> omit it");

    // explicit finite temperature -> preserved (backward compatible for callers that want one)
    await callOpenAICompatiblePlanner({ model: "m", baseUrl: "http://x/v1", apiKey: "k", systemPrompt: "s", userPrompt: "u", temperature: 0.5 });
    assert.equal(bodies[1].temperature, 0.5, "explicit finite temperature -> sent");

    // explicit null -> omit
    await callOpenAICompatiblePlanner({ model: "m", baseUrl: "http://x/v1", apiKey: "k", systemPrompt: "s", userPrompt: "u", temperature: null });
    assert.equal("temperature" in bodies[2], false, "explicit null temperature -> omit it");
  } finally {
    globalThis.fetch = origFetch;
  }
});
