export function normalizeString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function normalizeContractIdentity(value) {
  const normalized = normalizeString(value);
  return normalized ? normalized.toLowerCase() : null;
}

export function normalizeRecord(value, fallback = {}) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : fallback;
}

export function normalizeBoolean(value) {
  if (typeof value === "boolean") return value;
  const normalized = normalizeString(value)?.toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

export function uniqueStrings(values) {
  return [...new Set(
    (Array.isArray(values) ? values : [])
      .map((value) => normalizeString(value))
      .filter(Boolean),
  )];
}

const TOOL_ALIASES = Object.freeze({
  websearch: "web_search",
  webfetch: "web_fetch",
});

export function uniqueTools(values) {
  const seen = new Set();
  const tools = [];
  for (const raw of Array.isArray(values) ? values : []) {
    const value = normalizeString(raw);
    if (!value) continue;
    const normalized = TOOL_ALIASES[value.toLowerCase()] || value.toLowerCase();
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    tools.push(normalized);
  }
  return tools;
}

// ── Numeric normalization (consolidated from duplicated local copies) ────────

export function normalizePositiveInteger(value, fallback = 0) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

export function normalizeFiniteNumber(value, fallback = null) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const parsed = Number.parseFloat(String(value ?? ""));
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function normalizeCount(value, fallback = 0) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return parsed;
}

export function normalizeEnum(value, validSet, fallback = null) {
  const normalized = normalizeString(value)?.toLowerCase();
  return normalized && validSet.has(normalized) ? normalized : fallback;
}

export function getErrorMessage(error) {
  return error instanceof Error ? error.message : String(error || "unknown");
}

export function compactText(value, maxLength = 180) {
  const normalized = normalizeString(value);
  if (!normalized) return null;
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 3))}...`;
}
