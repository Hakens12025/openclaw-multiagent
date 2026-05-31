import { normalizeString } from "../core/normalize.js";

/**
 * Shared helpers used by both automation-admin and schedule-admin.
 * Extracted to eliminate copy-paste between the two admin modules.
 */

export function parseDeliveryTargetsText(value) {
  const text = normalizeString(value);
  if (!text) return [];

  // Best-effort JSON parse — fall through to line-based parsing if it fails.
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed;
    if (parsed && typeof parsed === "object") return [parsed];
  } catch {
    // Not JSON; continue to line-based parsing below.
  }

  return text
    .split(/\n+/g)
    .map((line) => normalizeString(line))
    .filter(Boolean)
    .map((line) => {
      const [channel, target, mode] = line.includes("|")
        ? line.split("|").map((item) => item.trim())
        : line.split(/\s+/g);
      return {
        channel,
        target,
        ...(normalizeString(mode) ? { mode: normalizeString(mode) } : {}),
      };
    });
}

export function resolveDeliveryTargets(payload) {
  if (Array.isArray(payload.deliveryTargets)) {
    return payload.deliveryTargets;
  }
  return parseDeliveryTargetsText(payload.deliveryTargetsText || payload.deliveryTargetsJson);
}

export function mergeNestedRecord(existing, value) {
  return {
    ...(existing && typeof existing === "object" ? existing : {}),
    ...(value && typeof value === "object" ? value : {}),
  };
}
