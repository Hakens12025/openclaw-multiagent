import { normalizeString } from "./core/normalize.js";

function compareModels(left, right) {
  const providerDiff = String(left?.provider || "").localeCompare(String(right?.provider || ""));
  if (providerDiff !== 0) return providerDiff;
  return String(left?.id || "").localeCompare(String(right?.id || ""));
}

export async function buildModelRegistry(config) {
  const models = [];
  const providers = config?.models?.providers && typeof config.models.providers === "object"
    ? config.models.providers
    : {};

  for (const [provider, providerConfig] of Object.entries(providers)) {
    const normalizedProvider = normalizeString(provider);
    if (!normalizedProvider) continue;
    const providerRecord = providerConfig && typeof providerConfig === "object" ? providerConfig : {};
    for (const model of Array.isArray(providerRecord.models) ? providerRecord.models : []) {
      const id = normalizeString(model?.id);
      if (!id) continue;
      models.push({
        provider: normalizedProvider,
        id,
        name: normalizeString(model?.name) || id,
        contextWindow: Number.isFinite(model?.contextWindow) ? model.contextWindow : null,
        api: normalizeString(providerRecord.api) || null,
        baseUrl: normalizeString(providerRecord.baseUrl) || null,
      });
    }
  }

  return models.sort(compareModels);
}
