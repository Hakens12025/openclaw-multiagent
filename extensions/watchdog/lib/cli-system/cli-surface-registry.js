import { listAdminSurfaces } from "../admin/admin-surface-registry.js";
import { normalizeBoolean, normalizeString } from "../core/normalize.js";
import { CLI_SYSTEM_STATIC_SURFACES } from "./cli-surface-catalog.js";

const CLI_SYSTEM_FAMILIES = Object.freeze([
  "hook",
  "observe",
  "inspect",
  "apply",
  "verify",
]);

function cloneJsonValue(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function normalizeFamily(value) {
  const normalized = normalizeString(value)?.toLowerCase();
  return normalized && CLI_SYSTEM_FAMILIES.includes(normalized) ? normalized : null;
}

function normalizeStaticSurface(surface) {
  return {
    ...surface,
    family: normalizeFamily(surface?.family) || "observe",
    stage: null,
    subject: null,
    verificationCapability: null,
  };
}

function normalizeAdminSurface(surface) {
  const family = normalizeFamily(surface?.stage) || "inspect";
  return {
    ...surface,
    family,
    source: "admin_surface",
  };
}

function matchesOperatorExecutable(surface, requested) {
  if (requested == null) return true;
  return (surface?.operatorExecutable === true) === requested;
}

function matchesFilter(surface, filters = {}) {
  const id = normalizeString(filters.id);
  const family = normalizeFamily(filters.family || filters.stage);
  const status = normalizeString(filters.status);
  const source = normalizeString(filters.source);
  const operatorExecutable = Object.prototype.hasOwnProperty.call(filters, "operatorExecutable")
    ? filters.operatorExecutable === true
    : null;

  if (id && surface?.id !== id) return false;
  if (family && surface?.family !== family) return false;
  if (status && normalizeString(surface?.status) !== status) return false;
  if (source && normalizeString(surface?.source) !== source) return false;
  if (!matchesOperatorExecutable(surface, operatorExecutable)) return false;
  return true;
}

function buildCliSystemSurfaceList(options = {}) {
  const includeTemplates = normalizeBoolean(options.includeTemplates);
  const adminSurfaces = listAdminSurfaces({}, { includeTemplates }).map(normalizeAdminSurface);
  const staticSurfaces = CLI_SYSTEM_STATIC_SURFACES.map(normalizeStaticSurface);
  return [...staticSurfaces, ...adminSurfaces];
}

export function listCliSystemSurfaces(filters = {}, options = {}) {
  return buildCliSystemSurfaceList(options)
    .filter((surface) => matchesFilter(surface, filters))
    .map((surface) => cloneJsonValue(surface));
}

export function getCliSystemSurface(id, options = {}) {
  const surfaceId = normalizeString(id);
  if (!surfaceId) return null;
  return listCliSystemSurfaces({ id: surfaceId }, options)[0] || null;
}

export function summarizeCliSystemSurfaces(filters = {}, options = {}) {
  const surfaces = listCliSystemSurfaces(filters, options);
  const counts = {
    total: surfaces.length,
    operatorExecutable: surfaces.filter((surface) => surface?.operatorExecutable === true).length,
    executable: surfaces.filter((surface) => surface?.executable === true).length,
    byFamily: Object.fromEntries(
      CLI_SYSTEM_FAMILIES.map((family) => [
        family,
        surfaces.filter((surface) => surface?.family === family).length,
      ]),
    ),
  };
  return { counts, surfaces };
}
