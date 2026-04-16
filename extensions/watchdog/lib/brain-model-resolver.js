import { normalizeString } from "./core/normalize.js";

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
        apiKey: normalizeString(provider.apiKey),
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
      apiKey: normalizeString(provider.apiKey),
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
