import { getCliSystemSurface, listCliSystemSurfaces } from "../cli-system/cli-surface-registry.js";
import { normalizeString } from "../core/normalize.js";

export function listOperatorExecutableSurfaceIds() {
  return listCliSystemSurfaces({
    family: "apply",
    status: "active",
    operatorExecutable: true,
  }).filter((surface) => surface?.executable === true)
    .map((surface) => surface.id);
}

export function isOperatorExecutableSurfaceId(surfaceId) {
  const surface = getCliSystemSurface(normalizeString(surfaceId));
  return surface?.family === "apply"
    && surface?.status === "active"
    && surface?.executable === true
    && surface?.operatorExecutable === true;
}

export function listOperatorExecutableAdminSurfaces(options = {}) {
  const includeTemplates = options?.includeTemplates === true;
  return listCliSystemSurfaces({
    family: "apply",
    status: "active",
    operatorExecutable: true,
  }, { includeTemplates }).filter((surface) => surface?.executable === true);
}
