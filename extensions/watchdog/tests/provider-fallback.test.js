import test from "node:test";
import assert from "node:assert/strict";

// TIER-1 (备忘录125): declarative provider fallback chain for the brain-model resolution.
// Two layers under test, both pure / dependency-injected (no live providers, no module mocks):
//   resolveBrainModelChain(config)       — ordered ready chain [primary, ...ready fallbacks]
//   callPlannerWithModelFallback({...})   — walk the chain, fall back ONLY on provider-class errors
import { resolveOperatorBrainModel, resolveBrainModelChain } from "../lib/llm/brain-model-resolver.js";
import { callPlannerWithModelFallback } from "../lib/operator/operator-brain.js";

function multiProviderConfig({ primaryRef, fallbacks }) {
  return {
    // "fallbacks" (plural) = the core-native AgentModelSchema field; singular is schema-rejected.
    agents: { defaults: { model: { primary: primaryRef, ...(fallbacks ? { fallbacks } : {}) } } },
    models: {
      providers: {
        ark: { api: "openai-completions", baseUrl: "http://ark/v1", apiKey: "ka", models: [{ id: "m-ark" }] },
        glm: { api: "openai-completions", baseUrl: "http://glm/v1", apiKey: "kg", models: [{ id: "m-glm" }] },
        noauth: { api: "openai-completions", baseUrl: "http://noauth/v1", models: [{ id: "m-no" }] }, // no apiKey → not ready
        other: { api: "anthropic-messages", baseUrl: "http://o/v1", apiKey: "ko", models: [{ id: "m-o" }] }, // wrong api
      },
    },
  };
}

// ── resolveBrainModelChain ──────────────────────────────────────────────────
test("chain: no fallback declared → chain is just the primary (today's behavior)", () => {
  const chain = resolveBrainModelChain(multiProviderConfig({ primaryRef: "ark/m-ark" }));
  assert.equal(chain.length, 1);
  assert.equal(chain[0].fullRef, "ark/m-ark");
  assert.equal(chain[0].baseUrl, "http://ark/v1");
  assert.equal(chain[0].apiKey, "ka");
});

test("chain: ordered primary then ready fallbacks; unready skipped; deduped", () => {
  const chain = resolveBrainModelChain(multiProviderConfig({
    primaryRef: "ark/m-ark",
    fallbacks: ["glm/m-glm", "noauth/m-no", "other/m-o", "ark/m-ark"],
  }));
  assert.deepEqual(chain.map((m) => m.fullRef), ["ark/m-ark", "glm/m-glm"],
    "glm ready; noauth(no key) + other(wrong api) skipped; ark duplicate deduped");
});

test("chain: empty when nothing resolves to a ready openai-completions provider", () => {
  const chain = resolveBrainModelChain({ agents: { defaults: { model: { primary: "ghost/x" } } }, models: { providers: {} } });
  assert.equal(chain.length, 0);
});

test("chain: a not-ready primary (no apiKey) is dropped; chain starts at the first ready fallback", () => {
  const chain = resolveBrainModelChain(multiProviderConfig({ primaryRef: "noauth/m-no", fallbacks: ["glm/m-glm"] }));
  assert.deepEqual(chain.map((m) => m.fullRef), ["glm/m-glm"]);
});

test("resolveOperatorBrainModel unchanged: still returns the primary ref (back-compat)", () => {
  const m = resolveOperatorBrainModel(multiProviderConfig({ primaryRef: "ark/m-ark", fallbacks: ["glm/m-glm"] }));
  assert.equal(m.fullRef, "ark/m-ark");
});

// ── callPlannerWithModelFallback ────────────────────────────────────────────
const M = (ref) => ({ providerId: ref.split("/")[0], modelId: ref.split("/")[1], fullRef: ref, baseUrl: `http://${ref.split("/")[0]}/v1`, apiKey: "k" });
const GOOD = { intent: "graph_mutation", steps: [{ surfaceId: "graph.edge.add" }] };
const sockErr = () => Object.assign(new Error("fetch failed"), { cause: { code: "UND_ERR_SOCKET" } });
const parseErr = () => Object.assign(new Error("planner JSON parse failed after repair"), { code: "PLANNER_JSON_PARSE_FAILED" });

test("fallback: single model success → 1 call, served by primary, args threaded", async () => {
  const calls = [];
  const out = await callPlannerWithModelFallback({
    modelChain: [M("ark/x")],
    plannerArgs: { systemPrompt: "s", userPrompt: "u", maxTokens: 8192 },
    callPlanner: async (a) => { calls.push(a); return GOOD; },
  });
  assert.deepEqual(out.plan, GOOD);
  assert.equal(out.servedBy.fullRef, "ark/x");
  assert.equal(out.fallbacksTried.length, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].model, "x");
  assert.equal(calls[0].baseUrl, "http://ark/v1");
  assert.equal(calls[0].maxTokens, 8192, "plannerArgs threaded through");
});

test("fallback: provider error on primary → walks to 2nd, served by 2nd", async () => {
  const calls = [];
  const out = await callPlannerWithModelFallback({
    modelChain: [M("ark/x"), M("glm/y")],
    plannerArgs: { userPrompt: "u" },
    callPlanner: async (a) => { calls.push(a.model); if (a.model === "x") throw sockErr(); return GOOD; },
  });
  assert.deepEqual(out.plan, GOOD);
  assert.equal(out.servedBy.fullRef, "glm/y");
  assert.equal(out.fallbacksTried.length, 1);
  assert.equal(out.fallbacksTried[0].providerRef, "ark/x");
  assert.deepEqual(calls, ["x", "y"]);
});

test("fallback: PLANNER_JSON_PARSE_FAILED is a CONTENT error → does NOT cross-provider fallback", async () => {
  const calls = [];
  await assert.rejects(() => callPlannerWithModelFallback({
    modelChain: [M("ark/x"), M("glm/y")],
    plannerArgs: { userPrompt: "u" },
    callPlanner: async (a) => { calls.push(a.model); throw parseErr(); },
  }), (e) => e.code === "PLANNER_JSON_PARSE_FAILED");
  assert.deepEqual(calls, ["x"], "must not try a 2nd provider on a content/parse error");
});

test("fallback: all providers throw provider error → throws the last error", async () => {
  const calls = [];
  await assert.rejects(() => callPlannerWithModelFallback({
    modelChain: [M("ark/x"), M("glm/y")],
    plannerArgs: { userPrompt: "u" },
    callPlanner: async (a) => { calls.push(a.model); throw new Error(`down-${a.model}`); },
  }), /down-y/);
  assert.deepEqual(calls, ["x", "y"]);
});

test("fallback: empty chain → throws (caller must resolve readiness first)", async () => {
  await assert.rejects(
    () => callPlannerWithModelFallback({ modelChain: [], plannerArgs: {}, callPlanner: async () => GOOD }),
    /empty/,
  );
});

test("fallback: onFallback hook fires only when a non-primary served", async () => {
  const events = [];
  await callPlannerWithModelFallback({
    modelChain: [M("ark/x"), M("glm/y")],
    plannerArgs: { userPrompt: "u" },
    callPlanner: async (a) => { if (a.model === "x") throw sockErr(); return GOOD; },
    onFallback: (e) => events.push(e),
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].servedBy, "glm/y");
  assert.equal(events[0].primary, "ark/x");
});
