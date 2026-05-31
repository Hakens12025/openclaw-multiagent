(function attachDashboardSurfaceDisplay(globalScope) {
  const DISPLAY_NAMESPACE = "control";

  function normalizeSurfaceValue(value) {
    return String(value ?? "").trim();
  }

  function getExplicitDisplayId(surfaceOrId) {
    if (!surfaceOrId || typeof surfaceOrId !== "object") return null;
    const displayId = normalizeSurfaceValue(surfaceOrId.displayId);
    return displayId || null;
  }

  function getCanonicalSurfaceId(surfaceOrId) {
    if (surfaceOrId && typeof surfaceOrId === "object") {
      return normalizeSurfaceValue(surfaceOrId.id || surfaceOrId.surfaceId) || null;
    }
    return normalizeSurfaceValue(surfaceOrId) || null;
  }

  function buildSurfaceDisplayId(surfaceOrId) {
    const canonicalId = getCanonicalSurfaceId(surfaceOrId);
    if (!canonicalId) return null;
    if (canonicalId.startsWith(`${DISPLAY_NAMESPACE}:`)) {
      return canonicalId;
    }
    return `${DISPLAY_NAMESPACE}:${canonicalId}`;
  }

  function resolveSurfaceDisplayId(surfaceOrId, fallbackSurface = null) {
    const explicitDisplayId = getExplicitDisplayId(surfaceOrId) || getExplicitDisplayId(fallbackSurface);
    if (explicitDisplayId) return explicitDisplayId;
    return buildSurfaceDisplayId(surfaceOrId) || buildSurfaceDisplayId(fallbackSurface) || null;
  }

  function formatSurfaceDisplayId(surfaceOrId, fallback = "--", fallbackSurface = null) {
    return resolveSurfaceDisplayId(surfaceOrId, fallbackSurface) || fallback;
  }

  globalScope.OpenClawSurfaceDisplay = Object.freeze({
    DISPLAY_NAMESPACE,
    buildSurfaceDisplayId,
    resolveSurfaceDisplayId,
    formatSurfaceDisplayId,
  });
}(typeof globalThis !== "undefined" ? globalThis : window));
