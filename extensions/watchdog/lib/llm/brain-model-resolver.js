import { readFileSync } from "node:fs";

import { normalizeString } from "../core/normalize.js";

function resolveModelRef(model) {
  if (typeof model === "string" && model.trim()) return model.trim();
  if (model && typeof model === "object") {
    if (typeof model.primary === "string" && model.primary.trim()) return model.primary.trim();
    if (typeof model.default === "string" && model.default.trim()) return model.default.trim();
  }
  return null;
}

function splitModelRef(modelRef) {
  const normalized = normalizeString(modelRef);
  if (!normalized) return { providerId: null, modelId: null, fullRef: null };
  const slashIndex = normalized.indexOf("/");
  if (slashIndex === -1) {
    return { providerId: null, modelId: normalized, fullRef: normalized };
  }
  return {
    providerId: normalized.slice(0, slashIndex),
    modelId: normalized.slice(slashIndex + 1),
    fullRef: normalized,
  };
}

export { resolveModelRef };

export function resolveProviderApiKey(provider, env = process.env) {
  const inlineKey = normalizeString(provider?.apiKey);
  if (inlineKey) {
    if (inlineKey.startsWith("env:")) {
      const envName = normalizeString(inlineKey.slice("env:".length));
      return envName ? normalizeString(env[envName]) || null : null;
    }
    if (inlineKey.startsWith("file:")) {
      const keyFile = normalizeString(inlineKey.slice("file:".length));
      if (!keyFile) return null;
      try {
        return normalizeString(readFileSync(keyFile, "utf8"));
      } catch {
        return null;
      }
    }
    return inlineKey;
  }
  return null;
}

export function resolveOperatorBrainModel(config) {
  const defaultModelRef = resolveModelRef(config?.agents?.defaults?.model);
  const defaultParsed = splitModelRef(defaultModelRef);
  if (defaultParsed.providerId && defaultParsed.modelId) {
    const provider = config?.models?.providers?.[defaultParsed.providerId];
    if (provider && provider.api === "openai-completions") {
      return {
        providerId: defaultParsed.providerId,
        modelId: defaultParsed.modelId,
        fullRef: defaultParsed.fullRef,
        baseUrl: normalizeString(provider.baseUrl),
        apiKey: resolveProviderApiKey(provider),
      };
    }
  }

  const providers = config?.models?.providers && typeof config.models.providers === "object"
    ? config.models.providers
    : {};
  for (const [providerId, provider] of Object.entries(providers)) {
    if (!provider || provider.api !== "openai-completions") continue;
    const models = Array.isArray(provider.models) ? provider.models : [];
    const firstModelId = normalizeString(models[0]?.id);
    if (!firstModelId) continue;
    return {
      providerId,
      modelId: firstModelId,
      fullRef: `${providerId}/${firstModelId}`,
      baseUrl: normalizeString(provider.baseUrl),
      apiKey: resolveProviderApiKey(provider),
    };
  }

  return {
    providerId: defaultParsed.providerId,
    modelId: defaultParsed.modelId,
    fullRef: defaultParsed.fullRef,
    baseUrl: null,
    apiKey: null,
  };
}

// Resolve a single "providerId/modelId" ref against the configured providers.
// Returns a READY {providerId, modelId, fullRef, baseUrl, apiKey}, or null if the ref does not
// resolve to a usable + credentialed openai-completions provider (so unready fallbacks are skipped).
function resolveModelRefAgainstProviders(config, modelRefValue) {
  const parsed = splitModelRef(modelRefValue);
  if (!parsed.providerId || !parsed.modelId) return null;
  const provider = config?.models?.providers?.[parsed.providerId];
  if (!provider || provider.api !== "openai-completions") return null;
  const baseUrl = normalizeString(provider.baseUrl);
  const apiKey = resolveProviderApiKey(provider);
  if (!baseUrl || !apiKey) return null;
  return { providerId: parsed.providerId, modelId: parsed.modelId, fullRef: parsed.fullRef, baseUrl, apiKey };
}

// The ORDERED brain-model chain: the primary first, then each declared
// `agents.defaults.model.fallbacks` ref — the CORE-NATIVE field (AgentModelSchema declares
// {primary, fallbacks} with .strict(); a singular "fallback" key is rejected at gateway boot).
// Every entry is a READY provider; unresolvable / uncredentialed refs are skipped, duplicates are
// deduped by fullRef. Empty/absent fallbacks → today's single resolution (length 0 or 1). This is
// the TIER-1 provider-resilience seam (oh-my-pi borrow, 备忘录125): a persistent gateway degrades to
// the next provider on a quota/socket/timeout error instead of a manual openclaw.json edit +
// gateway restart (reference_glm_fallback.md). The primary reuses resolveOperatorBrainModel
// verbatim so primary selection stays byte-identical.
export function resolveBrainModelChain(config) {
  const chain = [];
  const seen = new Set();
  const push = (m) => {
    if (m && m.providerId && m.modelId && m.baseUrl && m.apiKey && !seen.has(m.fullRef)) {
      seen.add(m.fullRef);
      chain.push(m);
    }
  };

  push(resolveOperatorBrainModel(config));

  const fallbackRefs = config?.agents?.defaults?.model?.fallbacks;
  if (Array.isArray(fallbackRefs)) {
    for (const ref of fallbackRefs) push(resolveModelRefAgainstProviders(config, ref));
  }
  return chain;
}
