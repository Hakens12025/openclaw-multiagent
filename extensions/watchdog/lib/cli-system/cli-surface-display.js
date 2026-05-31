import { normalizeString } from "../core/normalize.js";

export const CLI_SYSTEM_DISPLAY_NAMESPACE = "control";

export function buildCliSystemDisplayId(surfaceOrId) {
  const candidate = typeof surfaceOrId === "object"
    ? surfaceOrId?.id || surfaceOrId?.surfaceId
    : surfaceOrId;
  const normalized = normalizeString(candidate);
  if (!normalized) return null;
  if (normalized.startsWith(`${CLI_SYSTEM_DISPLAY_NAMESPACE}:`)) {
    return normalized;
  }
  return `${CLI_SYSTEM_DISPLAY_NAMESPACE}:${normalized}`;
}
