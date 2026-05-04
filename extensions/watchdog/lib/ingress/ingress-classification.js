// lib/ingress-classification.js — Standard ingress shaping helpers

export function normalizeIngressPhases(phases) {
  if (!Array.isArray(phases)) return null;
  const normalized = phases
    .map((phase) => {
      if (typeof phase === "string" && phase.trim()) {
        return phase.trim();
      }
      if (phase && typeof phase === "object" && typeof phase.name === "string" && phase.name.trim()) {
        return {
          ...phase,
          name: phase.name.trim(),
          ...(typeof phase.description === "string" && phase.description.trim()
            ? { description: phase.description.trim() }
            : {}),
        };
      }
      return null;
    })
    .filter(Boolean);
  return normalized.length > 0 ? normalized : null;
}
